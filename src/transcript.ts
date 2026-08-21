import * as fs from 'fs'
import * as path from 'path'
import type { ContentBlock, ParsedSession, RawEntry, ToolInput } from './types.js'

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

/**
 * Recover the prompt from a slash command the user typed, e.g. `/plan APM-03`.
 *
 * These arrive wrapped in `<command-name>`/`<command-args>` tags, so `isMeta`
 * discards them as scaffolding — but for a session driven entirely by commands
 * that leaves nothing to title the row with, and Claude writes no `ai-title`
 * for one either, so the row reads "New session" forever while doing real work.
 *
 * Only commands that carry arguments count. A bare `/clear`, `/model` or
 * `/help` is control, not a prompt: `/clear` in particular opens every cleared
 * transcript, and titling the fresh row `/clear` is exactly the stale-looking
 * label this is all meant to avoid.
 */
function slashCommandPrompt(s: string): string | undefined {
  const name = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(s)?.[1]
  if (!name) {
    return undefined
  }
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim()
  if (!args) {
    return undefined
  }
  return `${name.startsWith('/') ? name : `/${name}`} ${args}`
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
      const raw = typeof c === 'string' ? c : userPromptText(state, c)
      // A wrapped slash command is scaffolding around something the user really
      // typed, so unwrap it rather than discarding it with the rest of the noise.
      const text = raw && isPromptNoise(raw) ? slashCommandPrompt(raw) : raw
      // `isMeta` on the entry marks Claude's own injections (skill bodies,
      // command scaffolding) — they are shaped like user turns but nothing the
      // user typed, and they otherwise dominate the preview line.
      if (text && !entry.isMeta) {
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

/**
 * The displayable view of the accumulated state. `title` is left undefined when
 * the transcript has produced no usable label yet — deliberately *not* a null
 * return, because a titleless transcript still carries everything else the row
 * needs (git branch, pending tool, error state, turn count). Right after
 * `/clear` that is the whole of the live transcript, and dropping it used to
 * lose the live session's real state as well as its title.
 */
function snapshot(state: ParseState): ParsedSession {
  // Clean *before* the emptiness check: a prompt that opens with a newline is
  // non-empty raw but cleans to '', which used to render as a blank row label.
  const clean = (s: string) => s.split('\n')[0].trim()
  const title = clean(state.aiTitle ?? state.lastPrompt ?? state.firstUser ?? '')
  return {
    title: title ? title.slice(0, 120) : undefined,
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
 * start. Returns null if the file can't be read; `data.title` is undefined for
 * sessions that have produced no usable label yet (empty or freshly-`/clear`ed
 * sessions), which callers resolve themselves.
 */
export function parseSessionFrom(
  filePath: string,
  size: number,
  prev?: ParseState,
): { state: ParseState; data: ParsedSession } | null {
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
