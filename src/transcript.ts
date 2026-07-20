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
 * Parse a session `.jsonl` into the fields we can show. Everything here is
 * read straight from the transcript — title and last activity.
 * Returns null for sessions with no usable title (empty sessions).
 */
export function parseSession(filePath: string): ParsedSession | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  let aiTitle: string | undefined
  let lastPrompt: string | undefined
  let firstUser: string | undefined
  let activity: string | undefined
  let stopReason: string | undefined
  let gitBranch: string | undefined
  let errored = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let entry: RawEntry
    try {
      entry = JSON.parse(trimmed) as RawEntry
    } catch {
      continue
    }

    // Outside the switch: system/attachment entries carry it too.
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
      gitBranch = entry.gitBranch
    }

    switch (entry.type) {
      case 'ai-title':
        if (entry.aiTitle) {
          aiTitle = entry.aiTitle
        }
        break
      case 'last-prompt':
        if (entry.lastPrompt) {
          lastPrompt = entry.lastPrompt
        }
        break
      case 'user': {
        const c = entry.message?.content
        if (typeof c === 'string' && !isMeta(c)) {
          // A typed user prompt — counts as the latest activity.
          if (firstUser === undefined) {
            firstUser = c
          }
          activity = c
        }
        break
      }
      case 'assistant': {
        // The last assistant turn tells us whether work is in progress
        // (`tool_use`) or finished (`end_turn`), and whether it errored.
        const sr = entry.message?.stop_reason
        if (typeof sr === 'string' && sr) {
          stopReason = sr
        }
        errored = !!(entry.isApiErrorMessage || entry.error)

        const blocks = entry.message?.content
        if (!Array.isArray(blocks)) {
          break
        }
        for (const b of blocks as ContentBlock[]) {
          if (b?.type === 'tool_use') {
            activity = describeTool(b.name ?? '', b.input)
          } else if (b?.type === 'text' && b.text?.trim() && !isMeta(b.text)) {
            activity = b.text.trim()
          }
        }
        break
      }
    }
  }

  const title = aiTitle ?? lastPrompt ?? firstUser
  if (!title) {
    return null
  }

  const clean = (s: string) => s.split('\n')[0].trim()
  return {
    title: clean(title).slice(0, 120),
    activity: activity ? clean(activity).slice(0, 120) : undefined,
    stopReason,
    gitBranch,
    errored,
  }
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
