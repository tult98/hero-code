import * as fs from 'fs'
import * as path from 'path'
import type { ContentBlock, ParsedSession, RawEntry, ToolInput } from './types.js'
import type { ChatBlock, ChatMessage, ChatToolUseBlock } from './chat/types.js'

/**
 * Claude Code stores each session as a `.jsonl` file under
 * `~/.claude/projects/<encoded-cwd>/`, where the directory name is the project
 * path with every non-alphanumeric character replaced by `-`.
 */
export function encodeProjectPath(folderPath: string): string {
  return folderPath.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Slash-command / tool wrapper tags that aren't meaningful prompt text. */
/**
 * Text that is recorded as a user turn but isn't something the user typed, so
 * it must never become a row's title or preview. Beyond the `isMeta` prefixes,
 * this catches Claude Code's interrupt markers — by far the most common
 * block-array user text, and meaningless as a session summary. Deliberately
 * narrow: real prompts do open with a bracket (`[Image #1] still broken`).
 */
function isPromptNoise(s: string): boolean {
  return isMeta(s) || /^\[Request interrupted by user/.test(s.trimStart())
}

function isMeta(s: string): boolean {
  return /^<(local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)/.test(
    s.trimStart(),
  )
}

/** A short, human label for the last assistant tool use. */
export function describeTool(name: string, input: ToolInput | undefined): string {
  const i = input ?? {}
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return i.file_path ? `${name} · ${path.basename(i.file_path)}` : name
    case 'Bash':
      return i.description ? `Bash · ${i.description}` : i.command ? `Bash · ${i.command}` : 'Bash'
    case 'Grep':
    case 'Glob':
      return i.pattern ? `${name} · ${i.pattern}` : name
    case 'Task':
    case 'Agent':
      return i.description ? `${name} · ${i.description}` : name
    case 'AskUserQuestion': {
      const headers = (i.questions ?? []).map((q) => q.header).filter(Boolean)
      return headers.length ? `AskUserQuestion · ${headers.join(', ')}` : 'AskUserQuestion'
    }
    default:
      return name
  }
}

/**
 * Everything `parseSession` accumulates while walking a transcript, kept
 * separately so a growing file can be resumed from where the last read
 * stopped instead of re-parsed from byte 0. Every field is last-wins except
 * `firstUser` (first-wins) and `pending` (a set), so folding a later chunk in
 * is just "keep going" — see `consume`.
 */
export interface ParseState {
  aiTitle?: string
  lastPrompt?: string
  firstUser?: string
  activity?: string
  stopReason?: string
  gitBranch?: string
  errored: boolean
  /**
   * tool_use ids seen with no matching tool_result yet, mapped to the tool's
   * name. Insertion-ordered, so the first key is the oldest outstanding call —
   * the one a parked turn is actually waiting on.
   */
  pending: Map<string, string>
  /**
   * Number of `system`/`turn_duration` entries seen. Claude writes exactly one
   * of these just after a turn's final `end_turn`, so this counter advancing is
   * an exact "a turn just finished" edge — unlike a busy↔idle status flip, which
   * happens several times *within* one turn.
   */
  turnCount: number
  /** Latest `system`/`away_summary` text: Claude's own recap of what it just did. */
  summary?: string
  /** Latest `permission-mode` entry — 'default' | 'auto' | 'plan' | 'acceptEdits'. */
  permissionMode?: string
  /** Bytes of the file consumed so far — where the next read resumes. */
  offset: number
  /**
   * Bytes after the last newline: an entry still being appended. Held as a
   * Buffer, not a string, so a chunk boundary landing mid-UTF-8-sequence
   * rejoins losslessly on the next read.
   */
  tail: Buffer
}

function newParseState(): ParseState {
  return { errored: false, pending: new Map(), turnCount: 0, offset: 0, tail: Buffer.alloc(0) }
}

/** Fold one transcript entry into the running state. */
function apply(state: ParseState, entry: RawEntry): void {
  // Outside the switch: system/attachment entries carry it too.
  if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
    state.gitBranch = entry.gitBranch
  }

  switch (entry.type) {
    case 'ai-title':
      if (entry.aiTitle) {
        state.aiTitle = entry.aiTitle
      }
      break
    case 'last-prompt':
      if (entry.lastPrompt) {
        state.lastPrompt = entry.lastPrompt
      }
      break
    case 'user': {
      const c = entry.message?.content
      // A typed prompt is a plain string, but any prompt carrying an `@file`
      // mention or a pasted image arrives as a block array instead. Reading
      // only strings meant those prompts never refreshed the row's preview
      // line, which is a large share of real messages.
      const text = typeof c === 'string' ? c : userPromptText(state, c)
      // `isMeta` on the entry marks Claude's own injections (skill bodies,
      // command scaffolding) — they are shaped like user turns but nothing the
      // user typed, and they otherwise dominate the preview line.
      if (text && !entry.isMeta && !isPromptNoise(text)) {
        // A typed user prompt — counts as the latest activity.
        if (state.firstUser === undefined) {
          state.firstUser = text
        }
        state.activity = text
      }
      break
    }
    case 'assistant': {
      // The last assistant turn tells us whether work is in progress
      // (`tool_use`) or finished (`end_turn`), and whether it errored.
      const sr = entry.message?.stop_reason
      if (typeof sr === 'string' && sr) {
        state.stopReason = sr
      }
      state.errored = !!(entry.isApiErrorMessage || entry.error)

      const blocks = entry.message?.content
      if (!Array.isArray(blocks)) {
        break
      }
      for (const b of blocks as ContentBlock[]) {
        if (b?.type === 'tool_use') {
          activityFromTool(state, b)
        } else if (b?.type === 'text' && b.text?.trim() && !isMeta(b.text)) {
          state.activity = b.text.trim()
        }
      }
      break
    }
    case 'system':
      // Claude writes `turn_duration` immediately after a turn's final
      // `end_turn`, and often an `away_summary` right behind it. Together they
      // are the only exact "the turn is over, here is what happened" signal in
      // the transcript.
      if (entry.subtype === 'turn_duration') {
        state.turnCount++
      } else if (entry.subtype === 'away_summary' && typeof entry.content === 'string') {
        state.summary = entry.content.trim() || undefined
      }
      break
    // Claude records mode switches mid-session under both spellings.
    case 'permission-mode':
      if (typeof entry.permissionMode === 'string' && entry.permissionMode) {
        state.permissionMode = entry.permissionMode
      }
      break
  }
}

function activityFromTool(state: ParseState, b: ContentBlock): void {
  state.activity = describeTool(b.name ?? '', b.input)
  if (b.id) {
    state.pending.set(b.id, b.name ?? '')
  }
}

/**
 * Text of a block-array user entry, or undefined when it isn't a prompt.
 * Tool results ride in as user entries too; those aren't something the user
 * typed, so they resolve `pending` and are otherwise ignored.
 */
function userPromptText(state: ParseState, content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined
  }
  const text: string[] = []
  let isToolResult = false
  for (const b of content as ContentBlock[]) {
    if (b?.type === 'tool_result') {
      isToolResult = true
      if (b.tool_use_id) {
        state.pending.delete(b.tool_use_id)
      }
    } else if (b?.type === 'text' && b.text?.trim()) {
      text.push(b.text.trim())
    }
  }
  return isToolResult || !text.length ? undefined : text.join('\n')
}

/** Parse whole lines out of `chunk`, carrying any partial final line forward. */
function consume(state: ParseState, chunk: Buffer): void {
  const buf = state.tail.length ? Buffer.concat([state.tail, chunk]) : chunk
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    state.tail = buf
    return
  }
  state.tail = buf.subarray(lastNewline + 1)

  for (const line of buf.subarray(0, lastNewline).toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      apply(state, JSON.parse(trimmed) as RawEntry)
    } catch {
      continue
    }
  }
}

/** The displayable view of the accumulated state, or null with no usable title. */
function snapshot(state: ParseState): ParsedSession | null {
  // Clean *before* the emptiness check: a prompt that opens with a newline is
  // non-empty raw but cleans to '', which used to render as a blank row label.
  const clean = (s: string) => s.split('\n')[0].trim()
  const title = clean(state.aiTitle ?? state.lastPrompt ?? state.firstUser ?? '')
  if (!title) {
    return null
  }
  return {
    title: title.slice(0, 120),
    activity: state.activity ? clean(state.activity).slice(0, 120) : undefined,
    stopReason: state.stopReason,
    gitBranch: state.gitBranch,
    errored: state.errored,
    pendingTool: state.pending.size > 0,
    // First key = oldest outstanding tool_use. While a turn stays parked on one
    // prompt this id is stable, which is what lets the notifier tell "still the
    // same question" from "a new one".
    pendingToolId: state.pending.keys().next().value,
    pendingToolName: state.pending.values().next().value,
    turnCount: state.turnCount,
    summary: state.summary,
    permissionMode: state.permissionMode,
  }
}

/**
 * Parse a session `.jsonl` into the fields we can show — title, last activity,
 * and whether a tool call is still outstanding. Everything here is read
 * straight from the transcript.
 *
 * Reads only `[prev.offset, size)`, folding the new entries into `prev`, so an
 * actively-working session costs the bytes it appended rather than a full
 * re-read of a file that routinely reaches megabytes. Pass no `prev` (or one
 * whose offset exceeds `size`, i.e. the file was truncated) to parse from the
 * start. Returns null if the file can't be read; `data` is null for sessions
 * with no usable title (empty sessions).
 */
export function parseSessionFrom(
  filePath: string,
  size: number,
  prev?: ParseState,
): { state: ParseState; data: ParsedSession | null } | null {
  const state = prev && prev.offset <= size ? prev : newParseState()
  if (size > state.offset) {
    let fd: number
    try {
      fd = fs.openSync(filePath, 'r')
    } catch {
      return null
    }
    try {
      const buf = Buffer.allocUnsafe(size - state.offset)
      const read = fs.readSync(fd, buf, 0, buf.length, state.offset)
      consume(state, buf.subarray(0, read))
      state.offset += read
    } catch {
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
  return { state, data: snapshot(state) }
}

/** Longest tool_result text we keep for display, to bound the hydrate payload. */
const MAX_RESULT_CHARS = 4000

/** Flatten a tool_result `content` (string or `{type:'text',text}[]`) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as ContentBlock).text === 'string' ? (b as ContentBlock).text : ''))
      .join('')
  }
  return ''
}

/**
 * The model id (e.g. `claude-opus-4-8`) of the most recent assistant turn on
 * disk, or undefined. Used to seed a resumed session's footer immediately: the
 * live SDK stream only reports the model once the first turn runs, so without
 * this the model reads as blank until you send a message.
 */
export function lastAssistantModel(filePath: string): string | undefined {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  let model: string | undefined
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      continue
    }
    const m = entry.type === 'assistant' ? (entry.message as { model?: string } | undefined)?.model : undefined
    if (m) {
      model = m
    }
  }
  return model
}

/**
 * Parse a session `.jsonl` into an ordered list of chat messages for display
 * when opening an existing (idle) session in the GUI chat. This is a fuller
 * read than `parseSession` (which only extracts a title): it emits user text,
 * assistant text, and tool-use cards, and attaches each tool_result back onto
 * its tool_use block.
 *
 * Sub-agent (`Agent` / `Task`) work is not inline in this file. Current Claude
 * Code writes each sub-agent's transcript to a sibling
 * `<sessionId>/subagents/agent-<id>.jsonl` (+ a `.meta.json` whose `toolUseId`
 * links it to the parent tool_use); we load those and hang them off the parent
 * card as `steps`. Legacy inline sidechain turns are dropped from the main
 * conversation (they'd otherwise duplicate the sub-agent thread).
 */
export function parseTranscriptMessages(filePath: string): ChatMessage[] {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const messages = parseMessagesFromContent(content, false)
  attachSubAgents(messages, subAgentIndex(filePath))
  return messages
}

/**
 * Parse the raw text of a transcript `.jsonl` into ordered chat messages. Shared
 * by the main transcript and each sub-agent transcript. `includeSidechain` is
 * false for the main file (its inline sidechain turns, if any, are legacy noise)
 * and true for a sub-agent file, whose every turn is a sidechain turn.
 */
function parseMessagesFromContent(content: string, includeSidechain: boolean): ChatMessage[] {
  const messages: ChatMessage[] = []
  // tool_use id → its rendered block, so a later tool_result can update it.
  const toolBlocks = new Map<string, ChatToolUseBlock>()
  let synthetic = 0

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      continue
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') {
      continue
    }
    if (entry.isSidechain && !includeSidechain) {
      continue
    }

    const raw = entry.message?.content
    const id = entry.uuid ?? `m${synthetic++}`

    if (entry.type === 'user') {
      // A plain typed prompt (string content), skipping slash-command/meta noise.
      if (typeof raw === 'string') {
        if (!isMeta(raw) && raw.trim()) {
          messages.push({ id, role: 'user', blocks: [{ type: 'text', text: raw }] })
        }
        continue
      }
      if (!Array.isArray(raw)) {
        continue
      }
      const text: ChatBlock[] = []
      for (const block of raw as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          // Attach the result to the matching tool card from an earlier turn.
          const target = toolBlocks.get(block.tool_use_id)
          if (target) {
            target.result = toolResultText(block.content).slice(0, MAX_RESULT_CHARS)
            target.status = block.is_error ? 'error' : 'done'
          }
        } else if (block.type === 'text' && block.text?.trim()) {
          text.push({ type: 'text', text: block.text })
        }
      }
      if (text.length) {
        messages.push({ id, role: 'user', blocks: text })
      }
      continue
    }

    // assistant
    if (!Array.isArray(raw)) {
      continue
    }
    const blocks: ChatBlock[] = []
    for (const block of raw as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim()) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use' && block.id) {
        const tool: ChatToolUseBlock = {
          type: 'tool_use',
          id: block.id,
          name: block.name ?? 'tool',
          label: describeTool(block.name ?? 'tool', block.input),
          input: block.input,
          status: 'done',
        }
        toolBlocks.set(block.id, tool)
        blocks.push(tool)
      }
    }
    if (blocks.length) {
      messages.push({ id, role: 'assistant', blocks })
    }
  }

  return messages
}

interface SubAgentMeta {
  agentType?: string
  /** Absolute path to the sub-agent's own `agent-<id>.jsonl` transcript. */
  file: string
}

/**
 * Index the sub-agent transcripts stored next to the main file: read every
 * `<sessionId>/subagents/*.meta.json` and key it by `toolUseId` (the parent
 * `Agent`/`Task` tool_use id). Returns an empty map when there are none.
 */
function subAgentIndex(mainFile: string): Map<string, SubAgentMeta> {
  const index = new Map<string, SubAgentMeta>()
  const subDir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents')
  let names: string[]
  try {
    names = fs.readdirSync(subDir)
  } catch {
    return index
  }
  for (const name of names) {
    if (!name.endsWith('.meta.json')) {
      continue
    }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, name), 'utf8')) as {
        agentType?: string
        toolUseId?: string
      }
      if (typeof meta.toolUseId !== 'string') {
        continue
      }
      index.set(meta.toolUseId, {
        agentType: meta.agentType,
        file: path.join(subDir, name.replace(/\.meta\.json$/, '.jsonl')),
      })
    } catch {
      continue
    }
  }
  return index
}

/**
 * Walk the message tree and, for every `Agent`/`Task` tool card that has a
 * matching sub-agent transcript, parse that transcript and hang it off the card
 * as `steps` (recursing so nested sub-agents, `spawnDepth > 1`, thread too).
 */
function attachSubAgents(messages: ChatMessage[], index: Map<string, SubAgentMeta>): void {
  if (index.size === 0) {
    return
  }
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || (block.name !== 'Agent' && block.name !== 'Task')) {
        continue
      }
      const meta = index.get(block.id)
      if (!meta) {
        continue
      }
      const subType = (block.input as { subagent_type?: unknown } | undefined)?.subagent_type
      block.agentType = (typeof subType === 'string' ? subType : undefined) ?? meta.agentType
      let text: string
      try {
        text = fs.readFileSync(meta.file, 'utf8')
      } catch {
        continue
      }
      const steps = parseMessagesFromContent(text, true)
      attachSubAgents(steps, index)
      block.steps = steps
    }
  }
}
