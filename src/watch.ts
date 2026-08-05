import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { encodeProjectPath } from './transcript.js'

/**
 * Coalescing window for filesystem events. A single status flip should feel
 * instant, but one assistant turn appends many transcript lines in a burst, so
 * we fire on the leading edge and then hold off until the burst settles.
 */
const DEBOUNCE_MS = 200

export interface ClaudeStateWatcher extends vscode.Disposable {
  /** Re-attach any watcher that failed to bind — call from the fallback poll. */
  retry(): void
}

/**
 * Watches the two directories the sidebar's state is derived from and calls
 * `onChange` when either moves:
 *
 * - `~/.claude/sessions` — Claude rewrites `<pid>.json` on every busy↔idle
 *   transition, so this is what makes status changes land in well under a
 *   second instead of on the next poll.
 * - `~/.claude/projects/<encoded-cwd>` — one per open workspace folder; catches
 *   transcript appends (title/activity) and newly created sessions.
 *
 * Watchers are best-effort: a workspace folder with no sessions yet has no
 * transcript directory, and some filesystems don't support watching at all.
 * `retry()` re-attempts whatever failed, and the caller's poll remains as the
 * safety net, so a failure degrades to the old behaviour rather than breaking.
 */
export function watchClaudeState(onChange: () => void): ClaudeStateWatcher {
  const watchers = new Map<string, fs.FSWatcher>()
  let timer: NodeJS.Timeout | undefined
  let pending = false
  let disposed = false

  const fire = (): void => {
    if (disposed) {
      return
    }
    if (timer) {
      // Inside the cooldown — remember to fire once when it expires, so the
      // last event of a burst is never dropped.
      pending = true
      return
    }
    onChange()
    timer = setTimeout(() => {
      timer = undefined
      if (pending) {
        pending = false
        fire()
      }
    }, DEBOUNCE_MS)
  }

  const watch = (dir: string): void => {
    if (watchers.has(dir)) {
      return
    }
    try {
      const w = fs.watch(dir, () => fire())
      // A watched directory can be deleted out from under us; drop the watcher
      // so `retry` can re-attach if it comes back.
      w.on('error', () => {
        watchers.delete(dir)
        w.close()
      })
      watchers.set(dir, w)
    } catch {
      // Directory doesn't exist yet (no sessions for this folder) — retry later.
    }
  }

  /** The directories we want watched, given the current workspace folders. */
  const targets = (): string[] => {
    const home = os.homedir()
    return [
      path.join(home, '.claude', 'sessions'),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
        path.join(home, '.claude', 'projects', encodeProjectPath(f.uri.fsPath)),
      ),
    ]
  }

  const retry = (): void => {
    if (disposed) {
      return
    }
    const wanted = new Set(targets())
    for (const [dir, w] of watchers) {
      if (!wanted.has(dir)) {
        w.close()
        watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      watch(dir)
    }
  }

  retry()
  const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => retry())

  return {
    dispose(): void {
      disposed = true
      folderListener.dispose()
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      for (const w of watchers.values()) {
        w.close()
      }
      watchers.clear()
    },
    retry,
  }
}
