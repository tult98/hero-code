import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import type { ParsedSession, RawEntry, SessionGroup, SessionItem, SessionMeta, Status } from './types.js'
import { encodeProjectPath, parseSession } from './transcript.js'

/** A live `claude` process, resolved from `~/.claude/sessions/<pid>.json`. */
interface LiveSession {
  /** The session id the process currently runs under (changes on `/clear`). */
  liveId: string
  /** Claude's own status string from the registry, e.g. 'busy' | 'idle'. */
  status?: string
}

/**
 * Map each live process's pid to its full command line. We use this to recover
 * the session id the extension *launched* with (`--session-id`/`--resume <id>`),
 * which diverges from the live session id after the user runs `/clear`. A single
 * `ps` call; empty map on any failure (e.g. non-unix platforms), in which case
 * callers fall back to matching by live id alone.
 */
function getProcessCommands(): Map<number, string> {
  const map = new Map<number, string>()
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (m) {
        map.set(Number(m[1]), m[2])
      }
    }
  } catch {
    // ps unavailable — degrade gracefully to live-id-only matching.
  }
  return map
}

/** Pulls the launch session id out of a `claude --session-id/--resume <uuid>` command line. */
const LAUNCH_ID_RE = /--(?:session-id|resume)[ =]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

/**
 * Live `claude` processes keyed by their **launch** id — the id the extension
 * started the terminal with, which is what our rows/terminals are tracked under.
 *
 * Claude registers each running process in `~/.claude/sessions/<pid>.json` with
 * its *current* session id and status; we confirm the PID is actually alive so
 * stale registrations don't count. `/clear` gives a live process a new session
 * id while the same terminal keeps running, so we join the registry's live id to
 * the launch id parsed from the process command line. Without a launch flag
 * (external `claude`, or when `ps` is unavailable) the launch id is the live id.
 */
function getLiveSessions(): Map<string, LiveSession> {
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  const byLaunch = new Map<string, LiveSession>()
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return byLaunch
  }

  const commands = getProcessCommands()
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    let entry: RawEntry
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RawEntry
    } catch {
      continue
    }
    if (!entry.sessionId || typeof entry.pid !== 'number') {
      continue
    }

    let alive = false
    try {
      process.kill(entry.pid, 0) // throws ESRCH if the process is gone
      alive = true
    } catch (err) {
      // EPERM means the process exists but we can't signal it — still alive.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        alive = true
      }
    }
    if (!alive) {
      continue
    }

    const liveId = entry.sessionId
    const cmd = commands.get(entry.pid)
    const launchId = cmd ? LAUNCH_ID_RE.exec(cmd)?.[1]?.toLowerCase() ?? liveId : liveId
    byLaunch.set(launchId, { liveId, status: entry.status })
  }
  return byLaunch
}

/**
 * A session is `idle` when no live process backs it, `error` when its transcript
 * ended in an API error, and otherwise reflects Claude's own live status
 * ('busy' → working, anything else → waiting for input). When the registry omits
 * a status we fall back to the transcript's last turn.
 */
function deriveStatus(live: LiveSession | undefined, parsed: ParsedSession): Status {
  if (parsed.errored) {
    return 'error'
  }
  if (!live) {
    return 'idle'
  }
  if (live.status === 'busy') {
    return 'working'
  }
  if (live.status) {
    return 'waiting'
  }
  return parsed.stopReason === 'tool_use' ? 'working' : 'waiting'
}

/** Cache parsed sessions by path + mtime so auto-refresh stays cheap. */
const cache = new Map<string, { mtime: number; data: ParsedSession | null }>()

/** Parse a transcript file, reusing the cached result while its mtime is unchanged. */
function parseCached(full: string): { mtime: number; data: ParsedSession | null } | null {
  let mtime: number
  try {
    mtime = fs.statSync(full).mtimeMs
  } catch {
    return null
  }
  let cached = cache.get(full)
  if (!cached || cached.mtime !== mtime) {
    cached = { mtime, data: parseSession(full) }
    cache.set(full, cached)
  }
  return cached
}

/** Scan one workspace folder's transcript directory, most recent first. */
function scanFolder(
  folderPath: string,
  live: Map<string, LiveSession>,
  meta: Record<string, SessionMeta>,
): SessionItem[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(folderPath))

  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  // Post-`/clear` live ids whose content we fold onto the launch row (below);
  // their standalone transcript must not appear as a duplicate row. Only alias
  // when the launch transcript actually exists here, so a live id we can't
  // re-home keeps its own row.
  const aliasedLiveIds = new Set<string>()
  for (const [launchId, info] of live) {
    if (info.liveId !== launchId && fs.existsSync(path.join(dir, `${launchId}.jsonl`))) {
      aliasedLiveIds.add(info.liveId)
    }
  }

  const items: SessionItem[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) {
      continue
    }
    const id = file.replace(/\.jsonl$/, '')
    if (aliasedLiveIds.has(id)) {
      continue
    }

    const cached = parseCached(path.join(dir, file))
    if (!cached || !cached.data) {
      continue
    }

    const info = live.get(id)
    let data = cached.data
    let mtime = cached.mtime

    // This launch id's process moved to a new live id via `/clear`; show the
    // live conversation's title/activity on this (pinned/tracked) row, keeping
    // the row id — and thus its terminal and pin/name/done metadata — stable.
    if (info && info.liveId !== id) {
      const liveCached = parseCached(path.join(dir, `${info.liveId}.jsonl`))
      if (liveCached?.data) {
        data = liveCached.data
        mtime = Math.max(mtime, liveCached.mtime)
      }
    }

    const m = meta[id]
    items.push({
      id,
      mtime,
      running: !!info,
      status: deriveStatus(info, data),
      ...data,
      customName: m?.name,
      pinned: m?.pinned,
      done: m?.done,
    })
  }

  // Pinned first, then running, then most-recently active.
  items.sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      Number(b.running) - Number(a.running) ||
      b.mtime - a.mtime,
  )
  return items
}

/** One group per open workspace folder, in workspace order. */
export function getSessionGroups(meta: Record<string, SessionMeta>): SessionGroup[] {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    return []
  }

  // Resolve live processes once and reuse the map across every folder scan.
  const live = getLiveSessions()

  return folders.map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
    sessions: scanFolder(folder.uri.fsPath, live, meta),
  }))
}
