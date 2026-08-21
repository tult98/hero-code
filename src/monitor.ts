import * as vscode from 'vscode'
import type { SessionGroup, SessionItem, SessionMeta } from './types.js'
import type { ClearChain } from './sessions.js'
import { getSessionGroups, NEW_SESSION_TITLE } from './sessions.js'
import type { ClaudeStateWatcher } from './watch.js'
import { watchClaudeState } from './watch.js'
import { hasSessionTerminal } from './terminal.js'

/** `globalState` key under which per-session user metadata is stored. */
const META_KEY = 'hero-code.sessionMeta'

/**
 * `globalState` key for the observed `/clear` lineage (live id -> launch id).
 * It has to be persisted rather than rebuilt each scan: once a process moves on
 * from a session id, nothing on disk records where that id came from, so a link
 * we don't capture while the process is alive is lost for good.
 */
const CHAIN_KEY = 'hero-code.clearChain'

/**
 * Ceiling on the persisted lineage. Each `/clear` adds one small entry and
 * nothing ever removes it — a transcript can be deleted from a folder we no
 * longer have open, so "the file is gone" isn't safe grounds for forgetting a
 * link. Trimming the oldest insertions past this bound keeps `globalState`
 * from growing without limit; the entries lost are years-old lineages whose
 * transcripts have long since stopped being listed.
 */
const MAX_CHAIN_ENTRIES = 5000

/**
 * Safety net for a "working" row whose live signal has gone stale — a latched
 * status rather than real activity (e.g. a registry entry stuck on 'busy').
 * Downgrade it to `ready` past this window.
 *
 * Freshness is measured against the *registry* heartbeat, not the transcript:
 * a session inside a long build or test run writes nothing to its transcript
 * for many minutes while remaining genuinely busy, and keying off transcript
 * mtime flipped exactly those rows to "waiting for input" while they worked.
 */
const STALE_WORKING_MS = 5 * 60_000

/** Fallback re-scan while the sidebar is on screen. */
const VISIBLE_POLL_MS = 15_000
/**
 * Fallback re-scan while nothing is watching. The filesystem watcher is still
 * the primary signal; this only covers filesystems where `fs.watch` is
 * unreliable and gives `watcher.retry()` a chance to bind directories that
 * didn't exist yet, so it can be much slower than the visible cadence.
 */
const HIDDEN_POLL_MS = 30_000
/**
 * Floor between watcher-driven scans while hidden. An active turn rewrites the
 * registry and appends to the transcript many times a second, and each scan
 * shells out to `ps`; sub-second precision buys a notification nothing.
 */
const HIDDEN_MIN_INTERVAL_MS = 1000

/**
 * One computed view of every session across the open workspace folders, shared
 * verbatim by the sidebar and the notifier so the two can never disagree about
 * a row's status.
 *
 * Treat it as immutable once emitted: `compute()` does all its mutation before
 * the event fires, but the arrays are handed to several consumers.
 */
export interface MonitorSnapshot {
  groups: SessionGroup[]
  /**
   * Ids whose `working` this tick's staleness guard downgraded to `ready`. A
   * downgrade is a latch clearing, not a turn ending, so anything watching for
   * "finished" has to skip these.
   */
  staleDowngraded: ReadonlySet<string>
  at: number
}

const EMPTY_SNAPSHOT: MonitorSnapshot = { groups: [], staleDowngraded: new Set(), at: 0 }

/**
 * Owns the session scan: the filesystem watcher, the fallback poll, the
 * persisted per-session metadata, and every adjustment layered on top of the raw
 * scan (optimistic rows, staleness guard).
 *
 * This deliberately lives outside the webview. Everything here used to hang off
 * `SessionsViewProvider.resolveWebviewView` behind an `if (view.visible)` guard,
 * which meant the extension knew nothing about a session that started needing
 * attention while the sidebar was closed — the exact case a notification exists
 * to cover.
 */
export class SessionMonitor implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MonitorSnapshot>()
  readonly onDidChange = this.changed.event

  private readonly subs: vscode.Disposable[] = []
  private watcher?: ClaudeStateWatcher
  private timer?: ReturnType<typeof setInterval>
  private trailing?: ReturnType<typeof setTimeout>
  private lastScanAt = 0
  private last: MonitorSnapshot = EMPTY_SNAPSHOT
  /** Signature of the last emit, used to swallow scans that changed nothing. */
  private signature = ''
  private viewVisible = false
  /** True once the sidebar has been resolved at least once this session. */
  private viewerAttached = false
  private disposed = false

  /**
   * New sessions started from the "+" button, keyed by their pre-assigned
   * session id → the folder path they belong to. Shown as optimistic rows until
   * the real transcript appears (or the terminal is closed), so the panel
   * reflects the session immediately instead of waiting for the first message.
   */
  private readonly pending = new Map<string, string>()

  constructor(private readonly memento: vscode.Memento) {
    // No visibility guard on any of these: the whole point is to keep deriving
    // state while nothing is on screen.
    this.watcher = watchClaudeState(() => this.onWatchEvent())
    this.subs.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()))
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('heroCode.notifications')) {
          this.refresh()
        }
      }),
    )
    this.arm(HIDDEN_POLL_MS)
  }

  /** The most recent computed state. Never undefined, so callers need no null check. */
  get snapshot(): MonitorSnapshot {
    return this.last
  }

  /** All persisted per-session metadata, keyed by session id. */
  getMeta(): Record<string, SessionMeta> {
    return this.memento.get<Record<string, SessionMeta>>(META_KEY, {})
  }

  /** The observed `/clear` lineage, as a fresh mutable copy the scan appends to. */
  private getChain(): ClearChain {
    return { ...this.memento.get<ClearChain>(CHAIN_KEY, {}) }
  }

  /**
   * Merge a patch into one session's metadata, drop keys that become empty so
   * the store stays tidy, persist, and re-scan so consumers see the change.
   */
  setMeta(id: string, patch: SessionMeta): void {
    const all = { ...this.getMeta() }
    const next: SessionMeta = { ...all[id], ...patch }
    if (!next.pinned) {
      delete next.pinned
    }
    if (!next.name) {
      delete next.name
    }
    if (!next.hidden) {
      delete next.hidden
    }
    if ('pinned' in patch) {
      // A pin/unpin moves the session between sections; its old within-section
      // rank no longer means anything there.
      delete next.order
    }
    if (Object.keys(next).length === 0) {
      delete all[id]
    } else {
      all[id] = next
    }
    void this.memento.update(META_KEY, all)
    this.refresh()
  }

  /**
   * Persist a full manual ordering for one section (a folder group's active
   * list, or the Pinned bucket) in a single `globalState` write: assigns
   * `order: index` to every id in `ids`, then re-scans once.
   */
  setOrder(ids: string[]): void {
    const all = { ...this.getMeta() }
    ids.forEach((id, index) => {
      all[id] = { ...all[id], order: index }
    })
    void this.memento.update(META_KEY, all)
    this.refresh()
  }

  /**
   * Soft-delete: hide these sessions from the sidebar in a single `globalState`
   * write, then re-scan once. The transcript files are left untouched on disk.
   */
  hideSessions(ids: string[]): void {
    const all = { ...this.getMeta() }
    for (const id of ids) {
      all[id] = { ...all[id], hidden: true }
    }
    void this.memento.update(META_KEY, all)
    this.refresh()
  }

  /** Track a "+"-started session so it shows up before its transcript exists. */
  addPending(id: string, folderPath: string): void {
    this.pending.set(id, folderPath)
  }

  /**
   * Follow the sidebar's visibility. This only changes the *poll cadence* — the
   * scan itself keeps running either way — and re-scans immediately on reveal so
   * a sidebar opened after a long absence isn't showing a stale snapshot.
   */
  setViewVisible(visible: boolean): void {
    this.viewerAttached = true
    if (this.viewVisible === visible) {
      return
    }
    this.viewVisible = visible
    this.arm(visible ? VISIBLE_POLL_MS : HIDDEN_POLL_MS)
    if (visible) {
      this.refresh()
    }
  }

  /** Re-scan now and emit if anything actually moved. */
  refresh(): void {
    if (this.disposed) {
      return
    }
    if (this.trailing) {
      clearTimeout(this.trailing)
      this.trailing = undefined
    }
    this.lastScanAt = Date.now()
    if (!this.shouldScan()) {
      return
    }
    const snap = this.compute()
    const sig = signatureOf(snap.groups)
    if (sig === this.signature && this.last !== EMPTY_SNAPSHOT) {
      // Nothing a consumer could act on changed. The watcher fires several times
      // per second during an active turn, most of them redundant.
      return
    }
    this.signature = sig
    this.last = snap
    this.changed.fire(snap)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.trailing) {
      clearTimeout(this.trailing)
      this.trailing = undefined
    }
    this.watcher?.dispose()
    this.watcher = undefined
    for (const s of this.subs) {
      s.dispose()
    }
    this.subs.length = 0
    this.changed.dispose()
  }

  /**
   * Skip the scan entirely when nobody would see the result: the sidebar has
   * never been opened and every background indicator is switched off. Keeps the
   * cost of `onStartupFinished` activation at zero for users who don't want any
   * of this.
   */
  private shouldScan(): boolean {
    if (this.viewerAttached) {
      return true
    }
    const cfg = vscode.workspace.getConfiguration('heroCode.notifications')
    return (
      cfg.get<boolean>('enabled', true) ||
      cfg.get<boolean>('badge', true) ||
      cfg.get<boolean>('statusBar', true)
    )
  }

  private onWatchEvent(): void {
    if (this.viewVisible) {
      this.refresh()
      return
    }
    const since = Date.now() - this.lastScanAt
    if (since >= HIDDEN_MIN_INTERVAL_MS) {
      this.refresh()
    } else if (!this.trailing) {
      // Inside the floor — remember to scan once when it expires, so the last
      // event of a burst is never dropped.
      this.trailing = setTimeout(() => {
        this.trailing = undefined
        this.refresh()
      }, HIDDEN_MIN_INTERVAL_MS - since)
    }
  }

  private arm(period: number): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = setInterval(() => {
      this.watcher?.retry()
      this.refresh()
    }, period)
  }

  /**
   * The raw scan plus every adjustment the sidebar used to apply on its way to
   * the webview. All of it happens here so the notifier and the sidebar read the
   * same statuses — a notifier working off unadjusted rows would fire "finished"
   * on the staleness guard.
   */
  private compute(): MonitorSnapshot {
    // The scan records any `/clear` hop it can see into `chain`; persist it
    // whenever that happened, so the lineage survives the process exiting and
    // the extension host restarting.
    const chain = this.getChain()
    const before = Object.keys(chain).length
    const groups = getSessionGroups(this.getMeta(), chain)
    if (Object.keys(chain).length !== before) {
      void this.memento.update(CHAIN_KEY, trimChain(chain))
    }

    // Merge optimistic rows for "+"-started sessions whose transcript hasn't
    // been written yet, so they appear (and can be selected) immediately.
    for (const [id, folderPath] of this.pending) {
      if (!hasSessionTerminal(id)) {
        // The terminal (or tmux session) is gone, so the session ended before
        // its first message — abandon it.
        this.pending.delete(id)
        continue
      }
      const group = groups.find((g) => g.path === folderPath)
      if (!group) {
        continue
      }
      if (group.sessions.some((s) => s.id === id)) {
        // The real transcript is now on disk; the scanned row supersedes ours.
        this.pending.delete(id)
        continue
      }
      const placeholder: SessionItem = {
        id,
        title: NEW_SESSION_TITLE,
        mtime: Date.now(),
        createdAt: Date.now(),
        running: true,
        status: 'ready',
      }
      group.sessions.unshift(placeholder)
    }

    // A row still marked "working" long after its last heartbeat is showing a
    // latched status rather than real activity. Prefer the registry heartbeat,
    // which keeps ticking through a long tool call; fall back to the transcript
    // only for rows with no live process behind them. Only ever downgrades
    // working → ready; placeholders carry a fresh mtime so are never caught here.
    const now = Date.now()
    const staleDowngraded = new Set<string>()
    for (const group of groups) {
      for (const session of group.sessions) {
        const fresh = session.liveUpdatedAt ?? session.mtime
        if (session.status === 'working' && now - fresh > STALE_WORKING_MS) {
          session.status = 'ready'
          staleDowngraded.add(session.id)
        }
      }
    }

    return { groups, staleDowngraded, at: now }
  }
}

/** Drop the oldest links once the lineage outgrows `MAX_CHAIN_ENTRIES`. */
function trimChain(chain: ClearChain): ClearChain {
  const keys = Object.keys(chain)
  if (keys.length <= MAX_CHAIN_ENTRIES) {
    return chain
  }
  const trimmed: ClearChain = {}
  // Object key order is insertion order for non-numeric keys, and session ids
  // are uuids, so the tail is the most recently observed set of links.
  for (const key of keys.slice(keys.length - MAX_CHAIN_ENTRIES)) {
    trimmed[key] = chain[key]
  }
  return trimmed
}

/**
 * Everything a consumer can act on, flattened to a string. Deliberately excludes
 * `mtime` alone — an append that changed no visible field shouldn't wake anyone.
 */
function signatureOf(groups: SessionGroup[]): string {
  const parts: string[] = []
  for (const g of groups) {
    parts.push(g.path)
    for (const s of g.sessions) {
      parts.push(
        `${s.id}${s.status}${s.title}${s.activity ?? ''}${s.turnCount ?? 0}${s.pendingToolId ?? ''}${s.customName ?? ''}${s.pinned ? 1 : 0}${s.gitBranch ?? ''}${s.liveId ?? ''}`,
      )
    }
  }
  return parts.join('')
}
