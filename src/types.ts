/**
 * `working` and `waiting` are the two states that want your attention: the
 * session is running, or it is blocked on you. `ready` is a live session
 * sitting at an empty prompt with nothing to answer — distinct from `idle`,
 * which means no live process backs the row at all.
 */
export type Status = 'working' | 'waiting' | 'ready' | 'error' | 'idle'

/** Fields derived purely from the transcript (no live-process knowledge). */
export interface ParsedSession {
  title: string
  activity?: string
  stopReason?: string
  errored?: boolean
  /**
   * A `tool_use` reached the end of the transcript with no matching
   * `tool_result`. While the process is busy that just means the tool is
   * running; once it goes quiet it means the turn is parked on a permission
   * prompt or an `AskUserQuestion` and genuinely needs the user.
   */
  pendingTool?: boolean
  /**
   * Id of the oldest outstanding `tool_use`. Stable for as long as a turn stays
   * parked on the same prompt, so it identifies *which* prompt is waiting —
   * `pendingTool` alone can't tell a still-unanswered question from a new one.
   */
  pendingToolId?: string
  /** Tool name of that outstanding call, e.g. 'AskUserQuestion' or 'Bash'. */
  pendingToolName?: string
  /**
   * How many turns have completed, counted from the `system`/`turn_duration`
   * entries Claude writes just after each turn's final `end_turn`. An advance
   * here is an exact turn-finished edge; a busy→idle status flip is not, since
   * the registry goes quiet between tool calls *within* a turn.
   */
  turnCount?: number
  /**
   * Claude's own recap of the turn it just finished (`system`/`away_summary`),
   * written for longer turns. Ideal notification body when present.
   */
  summary?: string
  /**
   * Session's current permission mode ('default' | 'auto' | 'plan' |
   * 'acceptEdits'), tracked mid-session. In `auto` Claude approves tools
   * itself, so an outstanding tool call there means "slow tool", not "needs you".
   */
  permissionMode?: string
  /**
   * Branch of the session cwd's git repo, from the last transcript entry that
   * recorded one (Claude snapshots it per entry, so this tracks mid-session
   * branch switches). Detached HEAD is the literal 'HEAD'.
   */
  gitBranch?: string
}

export interface SessionItem extends ParsedSession {
  id: string
  mtime: number
  /**
   * Creation time (ms) of the session's launch transcript — a stable ordering
   * key that, unlike `mtime`, never advances as the session works or after
   * `/clear`, so rows hold a fixed position in the list.
   */
  createdAt: number
  status: Status
  running: boolean
  /**
   * `statusUpdatedAt` of the live process backing this row. This — not `mtime`
   * — is the freshness signal for status: a session inside a long tool call
   * keeps heartbeating the registry while writing nothing to the transcript.
   */
  liveUpdatedAt?: number
  /**
   * The session id the process currently runs under, when it differs from the
   * display `id` after `/clear`. The row keeps the stable launch `id` for
   * tracking/meta, but resume and workspace lookup must target this live id.
   */
  liveId?: string
  /** PID of the live process backing this row, when running. Shown in debug mode. */
  pid?: number
  /** User-set custom name; when present the row shows it instead of `title`. */
  customName?: string
  /** Lifted into the top-level Pinned section, above all folder groups. */
  pinned?: boolean
  /** Name of the workspace folder this session belongs to. Shown in the row. */
  folder?: string
  /**
   * Manual rank within this session's current section (a folder group or the
   * Pinned bucket), set by dragging its row. Lower sorts earlier; absent
   * until the user drags something in that section. See `compareSessions`.
   */
  order?: number
}

/**
 * Per-session user metadata, persisted in the extension host's `globalState`
 * keyed by session id. This is the source of truth that survives auto-refresh,
 * webview reload, and extension restart; it is merged into each `SessionItem`.
 */
export interface SessionMeta {
  pinned?: boolean
  name?: string
  /** Persisted counterpart of `SessionItem.order` — see its doc comment. */
  order?: number
  /** Soft-deleted: excluded from `scanFolder`'s output. Transcript stays on disk. */
  hidden?: boolean
}

/**
 * Ordering for sessions within a single section (a folder group or the
 * Pinned bucket). Pinned-first only matters in the folder-group sort — it's a
 * no-op inside the Pinned bucket, where every item is already pinned. A
 * session with an explicit `order` (set by drag-and-drop) always sorts before
 * one without, so a freshly created/never-dragged session falls to the
 * bottom of an arranged list instead of interleaving by `createdAt`. Ties,
 * and "neither has an order", fall back to the original newest-first order.
 */
export function compareSessions(a: SessionItem, b: SessionItem): number {
  const pinnedDiff = Number(!!b.pinned) - Number(!!a.pinned)
  if (pinnedDiff !== 0) {
    return pinnedDiff
  }

  const aHas = a.order !== undefined
  const bHas = b.order !== undefined
  if (aHas && bHas) {
    if (a.order !== b.order) {
      return a.order! - b.order!
    }
  } else if (aHas !== bHas) {
    return aHas ? -1 : 1
  }

  return b.createdAt - a.createdAt || b.id.localeCompare(a.id)
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
  /** AskUserQuestion: the questions posed (only `header` is used for the label). */
  questions?: { header?: string }[]
}

export interface ContentBlock {
  type?: string
  name?: string
  input?: ToolInput
  text?: string
  /** tool_use id (assistant blocks) / tool_use_id (user tool_result blocks). */
  id?: string
  tool_use_id?: string
  /** tool_result payload: a string, or an array of `{ type:'text', text }`. */
  content?: unknown
  /** True on a tool_result block whose tool errored. */
  is_error?: boolean
}

export interface RawEntry {
  type?: string
  aiTitle?: string
  lastPrompt?: string
  isApiErrorMessage?: boolean
  error?: unknown
  sessionId?: string
  gitBranch?: string
  pid?: number
  /** Live status Claude writes into `~/.claude/sessions/<pid>.json` (e.g. 'busy' | 'idle'). */
  status?: string
  /** Registry only: Claude's own derived session name — a last-resort title. */
  name?: string
  /** Registry timestamps (ms) — used to pick the most-active among duplicate processes. */
  startedAt?: number
  updatedAt?: number
  statusUpdatedAt?: number
  message?: { content?: unknown; stop_reason?: string; role?: string }
  /**
   * True on a user-shaped entry Claude injected itself (a skill body, command
   * scaffolding) rather than one the user typed.
   */
  isMeta?: boolean
  /** Discriminator on `type: 'system'` entries, e.g. 'turn_duration' | 'away_summary'. */
  subtype?: string
  /** Top-level payload of a `system` entry (the away-summary prose). Distinct from `message.content`. */
  content?: unknown
  /** Wall-clock length of the turn a `turn_duration` entry closes. */
  durationMs?: number
  /** Mode recorded by a `permission-mode` entry. */
  permissionMode?: string
}
