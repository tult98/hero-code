import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ParsedSession, RawEntry, SessionGroup, SessionItem, Status } from './types.js'
import { encodeProjectPath, parseSession } from './transcript.js'

/**
 * Sessions with a live `claude` process, by sessionId. Claude registers each
 * running process in `~/.claude/sessions/<pid>.json`; we confirm the PID is
 * actually alive so stale registrations don't show as running.
 */
function getRunningSessionIds(): Set<string> {
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  const running = new Set<string>()
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return running
  }
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
    try {
      process.kill(entry.pid, 0) // throws ESRCH if the process is gone
      running.add(entry.sessionId)
    } catch (err) {
      // EPERM means the process exists but we can't signal it — still alive.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        running.add(entry.sessionId)
      }
    }
  }
  return running
}

function deriveStatus(running: boolean, parsed: ParsedSession): Status {
  if (parsed.errored) {
    return 'error'
  }
  if (!running) {
    return 'idle'
  }
  return parsed.stopReason === 'tool_use' ? 'working' : 'waiting'
}

/** Cache parsed sessions by path + mtime so auto-refresh stays cheap. */
const cache = new Map<string, { mtime: number; data: ParsedSession | null }>()

/** Scan one workspace folder's transcript directory, most recent first. */
function scanFolder(folderPath: string, running: Set<string>): SessionItem[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(folderPath))

  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  const items: SessionItem[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) {
      continue
    }
    const full = path.join(dir, file)
    let mtime: number
    try {
      mtime = fs.statSync(full).mtimeMs
    } catch {
      continue
    }

    let cached = cache.get(full)
    if (!cached || cached.mtime !== mtime) {
      cached = { mtime, data: parseSession(full) }
      cache.set(full, cached)
    }
    if (!cached.data) {
      continue
    }
    const id = file.replace(/\.jsonl$/, '')
    const isRunning = running.has(id)
    items.push({
      id,
      mtime,
      running: isRunning,
      status: deriveStatus(isRunning, cached.data),
      ...cached.data,
    })
  }

  // Running sessions first, then most-recently active.
  items.sort((a, b) => Number(b.running) - Number(a.running) || b.mtime - a.mtime)
  return items
}

/** One group per open workspace folder, in workspace order. */
export function getSessionGroups(): SessionGroup[] {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    return []
  }

  // Resolve live processes once and reuse the set across every folder scan.
  const running = getRunningSessionIds()

  return folders.map((folder) => ({
    name: folder.name,
    sessions: scanFolder(folder.uri.fsPath, running),
  }))
}
