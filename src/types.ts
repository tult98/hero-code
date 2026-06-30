export type Status = 'working' | 'waiting' | 'error' | 'idle'

/** Fields derived purely from the transcript (no live-process knowledge). */
export interface ParsedSession {
  title: string
  activity?: string
  branch?: string
  stopReason?: string
  errored?: boolean
}

export interface SessionItem extends ParsedSession {
  id: string
  mtime: number
  status: Status
  running: boolean
}

/** Sessions for a single workspace folder, rendered as one group. */
export interface SessionGroup {
  name: string
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
  gitBranch?: string
  sessionId?: string
  pid?: number
  message?: { content?: unknown; stop_reason?: string }
}
