import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import type { ParsedSession, RawEntry, SessionGroup, SessionItem, SessionMeta, Status } from './types.js'
import { compareSessions } from './types.js'
import type { ParseState } from './transcript.js'
import { encodeProjectPath, parseSessionFrom } from './transcript.js'

/** A live `claude` process, resolved from `~/.claude/sessions/<pid>.json`. */
interface LiveSession {
  /** The session id the process currently runs under (changes on `/clear`). */
  liveId: string
  /** Claude's own status string from the registry, e.g. 'busy' | 'idle'. */
  status?: string
  /** PID of the winning process (for the debug tooltip). */
  pid: number
  /**
   * Recency of the winning process (statusUpdatedAt/updatedAt/startedAt), used to
   * break ties when several processes back the same launch id.
   */
  updatedAt: number
  /** Claude's own derived session name, when the registry recorded one. */
  name?: string
  /**
   * Every live id seen across *all* alive processes that share this launch id.
   * When two terminals resume the same session, one may diverge to a new live id
   * (Claude forks a fresh session id for the second); we alias every diverged id
   * so its transcript never renders as a duplicate row.
   */
  allLiveIds: Set<string>
}

/** True when `a` is a more "active" live process than `b`: busy wins, then newer. */
function moreActive(a: { status?: string; updatedAt: number }, b: { status?: string; updatedAt: number }): boolean {
  const aBusy = a.status === 'busy'
  const bBusy = b.status === 'busy'
  if (aBusy !== bBusy) {
    return aBusy
  }
  return a.updatedAt > b.updatedAt
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
 * Confirms a registry entry's pid is still the process that wrote it. Kept
 * deliberately loose — a plain substring — because the two failure modes are
 * not symmetric: wrongly *rejecting* a live process hides a real session from
 * the sidebar, while wrongly accepting one only reproduces the ghost row we
 * already had. Every real invocation carries it (argv[0] is `claude`, or the
 * script path contains it); an unrelated process that inherits a recycled pid
 * essentially never does.
 */
const CLAUDE_CMD_RE = /claude/i

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

    const cmd = commands.get(entry.pid)
    // "Does this pid exist" isn't "is this pid still claude": registry files
    // outlive their process, and the OS recycles pids, which resurrected dead
    // sessions as live rows. EPERM above makes that *more* likely, since a
    // recycled pid owned by another user takes exactly that branch. When `ps`
    // gave us nothing at all (non-unix, or it failed) we can't check, so we
    // keep the old permissive behaviour rather than emptying the sidebar.
    if (commands.size && !(cmd && CLAUDE_CMD_RE.test(cmd))) {
      continue
    }

    const liveId = entry.sessionId
    const launchId = cmd ? LAUNCH_ID_RE.exec(cmd)?.[1]?.toLowerCase() ?? liveId : liveId
    const updatedAt = entry.statusUpdatedAt ?? entry.updatedAt ?? entry.startedAt ?? 0
    const candidate = { liveId, status: entry.status, pid: entry.pid, updatedAt, name: entry.name }

    // Several alive processes can share one launch id — e.g. two terminals both
    // `--resume <id>`, where the second diverges to a fresh live id. The registry
    // files are read in arbitrary order, so we must pick the winner deterministically
    // (the most-active process) rather than letting the last one read overwrite the
    // rest, and remember *every* live id so all diverged transcripts get aliased.
    const existing = byLaunch.get(launchId)
    if (!existing) {
      byLaunch.set(launchId, { ...candidate, allLiveIds: new Set([liveId]) })
    } else {
      existing.allLiveIds.add(liveId)
      if (moreActive(candidate, existing)) {
        byLaunch.set(launchId, { ...candidate, allLiveIds: existing.allLiveIds })
      }
    }
  }
  return byLaunch
}

/**
 * A live 'busy' process is checked first and beats everything: `errored` is the
 * flag from the transcript's *last* assistant turn, so an API error the user has
 * already retried past would otherwise pin the row to red while it works.
 *
 * Below that: no live process is `idle`; a transcript ending in an API error is
 * `error`; an outstanding tool call on a process that has gone quiet means the
 * turn is parked on a permission prompt and genuinely needs the user
 * (`waiting`); anything else live is `ready` — sitting at an empty prompt. Only
 * when the registry omits a status do we fall back to the transcript's last turn.
 */
function deriveStatus(live: LiveSession | undefined, parsed: ParsedSession): Status {
  if (live?.status === 'busy') {
    return 'working'
  }
  if (parsed.errored) {
    return 'error'
  }
  if (!live) {
    return 'idle'
  }
  if (parsed.pendingTool) {
    return 'waiting'
  }
  if (live.status) {
    return 'ready'
  }
  return parsed.stopReason === 'tool_use' ? 'working' : 'ready'
}

interface CacheEntry {
  mtime: number
  size: number
  birthtime: number
  /** Parser position, carried across refreshes so appends resume mid-file. */
  state: ParseState
  data: ParsedSession | null
}

/** Cache parsed sessions by path so auto-refresh only reads what was appended. */
const cache = new Map<string, CacheEntry>()

/** Paths seen in the current scan, used to evict entries for vanished files. */
let visited = new Set<string>()

/**
 * Parse a transcript file, resuming from the bytes already consumed. The
 * sessions that matter most — the ones actively working — change on every
 * refresh, so a whole-file re-read meant re-parsing a multi-megabyte JSONL on
 * the extension host thread each tick. Now a refresh costs the bytes appended.
 */
function parseCached(full: string): CacheEntry | null {
  visited.add(full)
  let mtime: number
  let size: number
  let birthtime: number
  try {
    const stat = fs.statSync(full)
    mtime = stat.mtimeMs
    size = stat.size
    // birthtime is the file's creation time — stable across writes. Some
    // filesystems report 0; fall back to mtime so ordering stays sane.
    birthtime = stat.birthtimeMs || stat.mtimeMs
  } catch {
    return null
  }

  const cached = cache.get(full)
  // Size is part of the validity check, not just mtime: on a filesystem with
  // coarse mtime granularity an append landing in the same tick as the last
  // stat would otherwise serve a stale parse forever.
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached
  }

  // A shrunk file was truncated or rewritten, so the carried offset is
  // meaningless — parseSessionFrom starts over when prev.offset exceeds size.
  const parsed = parseSessionFrom(full, size, cached?.state)
  if (!parsed) {
    return null
  }
  const entry: CacheEntry = { mtime, size, birthtime, state: parsed.state, data: parsed.data }
  cache.set(full, entry)
  return entry
}

/** Scan one workspace folder's transcript directory, newest-created first. */
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

  // Reconcile `/clear`ed processes, whose live id diverges from the launch id
  // the extension tracks them under. Live ids we handle here are aliased so their
  // standalone transcript never renders as a duplicate row.
  //
  //  - Launch transcript present → fold live content onto the launch row in the
  //    file loop below (its file is iterated; `deriveStatus`/re-home do the rest).
  //  - Launch transcript missing (a session cleared before it ever persisted a
  //    `<launchId>.jsonl`) → there's no file to iterate, so synthesize the row
  //    here, keyed by the *launch* id. Keeping the stable launch id is what lets
  //    the view's placeholder-supersede and per-session meta reconcile correctly.
  const aliasedLiveIds = new Set<string>()
  const synthesized: SessionItem[] = []
  for (const [launchId, info] of live) {
    // Every live id (from any alive process) that differs from the launch id is a
    // diverged transcript. There can be more than one when several terminals resume
    // the same session, so alias them all — not just the winning process's.
    const diverged = [...info.allLiveIds].filter((lid) => lid !== launchId)
    if (diverged.length === 0) {
      continue
    }
    if (fs.existsSync(path.join(dir, `${launchId}.jsonl`))) {
      for (const lid of diverged) {
        aliasedLiveIds.add(lid)
      }
      continue
    }
    const liveCached = parseCached(path.join(dir, `${info.liveId}.jsonl`))
    if (!liveCached?.data) {
      continue // Live transcript isn't in this folder — process belongs elsewhere.
    }
    aliasedLiveIds.add(info.liveId)
    const m = meta[launchId]
    if (m?.hidden) {
      continue
    }
    synthesized.push({
      id: launchId,
      liveId: info.liveId,
      pid: info.pid,
      mtime: liveCached.mtime,
      createdAt: liveCached.birthtime,
      running: true,
      liveUpdatedAt: info.updatedAt,
      status: deriveStatus(info, liveCached.data),
      ...liveCached.data,
      customName: m?.name,
      pinned: m?.pinned,
      order: m?.order,
    })
  }

  const items: SessionItem[] = [...synthesized]
  for (const file of files) {
    if (!file.endsWith('.jsonl')) {
      continue
    }
    const id = file.replace(/\.jsonl$/, '')
    if (aliasedLiveIds.has(id)) {
      continue
    }

    const cached = parseCached(path.join(dir, file))
    if (!cached) {
      continue
    }

    const info = live.get(id)
    // A live session whose transcript yields no title yet — the first prompt
    // hasn't flushed, or it carried only attachments — used to be dropped
    // outright, so a session you just started was missing from the sidebar.
    // The registry records Claude's own derived name; a rough label beats no row.
    let data = cached.data ?? (info?.name ? { title: info.name } : undefined)
    if (!data) {
      continue
    }
    let mtime = cached.mtime

    // This launch id's process moved to a new live id via `/clear`; show the
    // live conversation's title/activity on this (pinned/tracked) row, keeping
    // the row id — and thus its terminal and pin/name metadata — stable.
    if (info && info.liveId !== id) {
      const liveCached = parseCached(path.join(dir, `${info.liveId}.jsonl`))
      if (liveCached?.data) {
        data = liveCached.data
        mtime = Math.max(mtime, liveCached.mtime)
      }
    }

    const m = meta[id]
    if (m?.hidden) {
      continue
    }
    items.push({
      id,
      liveId: info && info.liveId !== id ? info.liveId : undefined,
      pid: info?.pid,
      mtime,
      // Always the launch transcript's birthtime — keep the row's position
      // fixed even after `/clear` swaps in a newer live transcript.
      createdAt: cached.birthtime,
      running: !!info,
      liveUpdatedAt: info?.updatedAt,
      status: deriveStatus(info, data),
      ...data,
      customName: m?.name,
      pinned: m?.pinned,
      order: m?.order,
    })
  }

  // Pinned first, then manual order (if set), then newest-created first — a
  // stable order that never reorders as a session works or its process
  // starts/stops.
  items.sort(compareSessions)
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

  visited = new Set()
  const groups = folders.map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
    sessions: scanFolder(folder.uri.fsPath, live, meta).map((s) => ({
      ...s,
      folder: folder.name,
    })),
  }))

  // Evict transcripts this scan never touched — deleted, archived, or in a
  // folder that has since been closed. Each entry holds a parsed session and a
  // carried tail buffer, so an unbounded cache leaks for the host's lifetime.
  for (const key of cache.keys()) {
    if (!visited.has(key)) {
      cache.delete(key)
    }
  }
  return groups
}
