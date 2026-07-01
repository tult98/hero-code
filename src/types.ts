export type Status = 'working' | 'waiting' | 'error' | 'idle'

/** Fields derived purely from the transcript (no live-process knowledge). */
export interface ParsedSession {
  title: string
  activity?: string
  stopReason?: string
  errored?: boolean
}

export interface SessionItem extends ParsedSession {
  id: string
  mtime: number
  status: Status
  running: boolean
  /** User-set custom name; when present the row shows it instead of `title`. */
  customName?: string
  /** Kept at the top of its group. */
  pinned?: boolean
  /** Marked done; hidden from the active list, revealed under "Done". */
  done?: boolean
}

/**
 * Per-session user metadata, persisted in the extension host's `globalState`
 * keyed by session id. This is the source of truth that survives auto-refresh,
 * webview reload, and extension restart; it is merged into each `SessionItem`.
 */
export interface SessionMeta {
  pinned?: boolean
  name?: string
  done?: boolean
}

/** Sessions for a single workspace folder, rendered as one group. */
export interface SessionGroup {
  name: string
  /** Folder's filesystem path — cwd for a new session started from this group. */
  path: string
  sessions: SessionItem[]
}

/** Minimal shapes of the transcript entries we read. */
export interface ToolInput {
  file_path?: string
  description?: string
  command?: string
  pattern?: string
}

export interface ContentBlock {
  type?: string
  name?: string
  input?: ToolInput
  text?: string
}

export interface RawEntry {
  type?: string
  aiTitle?: string
  lastPrompt?: string
  isApiErrorMessage?: boolean
  error?: unknown
  sessionId?: string
  pid?: number
  /** Live status Claude writes into `~/.claude/sessions/<pid>.json` (e.g. 'busy' | 'idle'). */
  status?: string
  message?: { content?: unknown; stop_reason?: string }
}
