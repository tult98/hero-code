import * as vscode from 'vscode'
import { postBanner } from './banner.js'
import type { SessionEvent, SessionEventKind } from './events.js'
import type { MonitorSnapshot } from './monitor.js'
import type { SessionItem } from './types.js'

/**
 * How long an event is held before it is delivered. Two jobs:
 *
 *  - Confirmation. A `waiting` row is inferred from an outstanding tool call on
 *    a process that has gone quiet, which is briefly true in the gap between
 *    tool calls. Re-checking after a beat drops those transients.
 *  - Ordering. Claude writes `turn_duration` and the `away_summary` that
 *    explains it as separate lines, and the watcher can read between them.
 *    Waiting lets the summary land so it can be used as the notification body.
 *
 * It also naturally batches a burst of sessions finishing together into one
 * notification.
 */
const GRACE_MS = 900

/** Minimum gap between notifications for the same session and kind. */
const COOLDOWN_MS = 10_000

/** Ceiling on popups per rolling minute; past it, the badge carries the signal. */
const MAX_PER_MINUTE = 6

/** Notification Center truncates anyway, and an away-summary can run long. */
const MAX_TITLE = 60
const MAX_BODY = 180

const OPEN = 'Open'

type Style = 'auto' | 'banner' | 'toast'
type WhenFocused = 'suppress-if-visible' | 'always' | 'never'

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('heroCode.notifications')
}

/**
 * Delivers attention events as a native banner or an in-editor notification.
 *
 * The split matters: a macOS banner is what reaches you once you've tabbed away
 * to a browser, where an in-editor notification is invisible. A banner carries
 * the editor's icon and clicking it brings the editor forward (see `banner.ts`),
 * but it has no per-session "Open" button — that exists only on the toast path,
 * with the activity-bar badge as the other way back.
 */
export class Notifier implements vscode.Disposable {
  private buffer: SessionEvent[] = []
  private timer?: ReturnType<typeof setTimeout>
  /** `${id}:${kind}` → last delivery time. */
  private readonly cooldowns = new Map<string, number>()
  private recent: number[] = []
  private disposed = false

  constructor(
    private readonly currentSnapshot: () => MonitorSnapshot,
    private readonly isSidebarVisible: () => boolean,
    private readonly open: (e: SessionEvent) => void,
    private readonly revealSidebar: () => void,
  ) {}

  push(events: SessionEvent[]): void {
    if (this.disposed || events.length === 0 || !cfg().get<boolean>('enabled', true)) {
      return
    }
    for (const e of events) {
      if (!this.kindEnabled(e.kind)) {
        continue
      }
      // Collapse repeats of the same session+kind already queued.
      const at = this.buffer.findIndex((b) => b.id === e.id && b.kind === e.kind)
      if (at >= 0) {
        this.buffer[at] = e
      } else {
        this.buffer.push(e)
      }
    }
    if (this.buffer.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, GRACE_MS)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.buffer = []
  }

  private kindEnabled(kind: SessionEventKind): boolean {
    const c = cfg()
    if (kind === 'waiting') {
      return c.get<boolean>('onNeedsInput', true)
    }
    if (kind === 'finished') {
      return c.get<boolean>('onTurnFinished', true)
    }
    return c.get<boolean>('onError', true)
  }

  private flush(): void {
    const queued = this.buffer
    this.buffer = []
    const now = Date.now()

    const rows = new Map<string, SessionItem>()
    for (const g of this.currentSnapshot().groups) {
      for (const s of g.sessions) {
        rows.set(s.id, s)
      }
    }

    // Forget cooldown bookkeeping for sessions that no longer exist.
    for (const key of this.cooldowns.keys()) {
      if (!rows.has(key.slice(0, key.lastIndexOf(':')))) {
        this.cooldowns.delete(key)
      }
    }

    const ready: SessionEvent[] = []
    for (const e of queued) {
      const row = rows.get(e.id)
      if (!row || row.done) {
        continue
      }
      if (e.kind === 'waiting') {
        // Confirm the session is *still* parked on the same prompt. A transient
        // gap between tool calls has resolved itself by now.
        if (row.status !== 'waiting' || (e.key && row.pendingToolId && row.pendingToolId !== e.key)) {
          continue
        }
        e.detail = row.activity
      } else if (e.kind === 'finished') {
        // The away-summary may only have landed during the grace window.
        e.detail = row.summary ?? e.detail
      }
      if (this.suppressed()) {
        continue
      }
      const key = `${e.id}:${e.kind}`
      const last = this.cooldowns.get(key) ?? 0
      if (now - last < COOLDOWN_MS) {
        continue
      }
      this.cooldowns.set(key, now)
      ready.push(e)
    }

    if (ready.length === 0) {
      return
    }

    // Sliding-window cap. Ten sessions finishing at once must not produce ten
    // banners; the badge and status bar still reflect all of them.
    this.recent = this.recent.filter((t) => now - t < 60_000)
    if (this.recent.length >= MAX_PER_MINUTE) {
      return
    }
    this.recent.push(now)

    if (ready.length === 1) {
      this.deliver(headline(ready[0]), body(ready[0]), ready[0])
    } else {
      const waiting = ready.filter((e) => e.kind === 'waiting').length
      const summary =
        waiting === ready.length
          ? `${waiting} Claude sessions need your input`
          : `${ready.length} Claude sessions need attention`
      this.deliver(summary, ready.map((e) => e.title).join(', '), undefined)
    }
  }

  /**
   * Stay quiet when the answer is already on screen. With the window focused and
   * the sidebar open, the row's status dot updates within a couple hundred
   * milliseconds — a popup on top of that is just noise.
   */
  private suppressed(): boolean {
    if (!vscode.window.state.focused) {
      return false
    }
    const mode = cfg().get<WhenFocused>('whenFocused', 'suppress-if-visible')
    if (mode === 'never') {
      return true
    }
    if (mode === 'always') {
      return false
    }
    return this.isSidebarVisible()
  }

  private deliver(title: string, detail: string, e: SessionEvent | undefined): void {
    const style = cfg().get<Style>('style', 'auto')
    const useBanner =
      process.platform === 'darwin' &&
      style !== 'toast' &&
      (style === 'banner' || !vscode.window.state.focused)

    if (useBanner) {
      nativeBanner(title, detail, cfg().get<boolean>('sound', false))
      return
    }

    const text = detail ? `${title} — ${detail}` : title
    const show =
      e?.kind === 'error' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
    void show(clean(text, 300), OPEN).then((choice) => {
      if (choice !== OPEN) {
        return
      }
      if (e) {
        this.open(e)
      } else {
        this.revealSidebar()
      }
    })
  }
}

function headline(e: SessionEvent): string {
  const what =
    e.kind === 'waiting'
      ? 'Needs your input'
      : e.kind === 'finished'
        ? 'Finished'
        : 'Session error'
  return e.folder ? `${what} · ${e.folder}` : what
}

function body(e: SessionEvent): string {
  return e.detail ? `${e.title} — ${e.detail}` : e.title
}

/**
 * Clamps to what Notification Center will show, then hands off to the helper
 * app that does the posting — see `banner.ts` for why a helper is needed at all.
 *
 * `clean` collapsing newlines is load-bearing there: it is what keeps the
 * line-per-field payload the helper reads unambiguous.
 */
function nativeBanner(title: string, detail: string, sound: boolean): void {
  postBanner(clean(title, MAX_TITLE), clean(detail, MAX_BODY), sound)
}

/** Collapse control characters and whitespace, then clamp. */
function clean(s: string, max: number): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat
}

/**
 * The quiet channel: a count of sessions blocked on the user, on the activity-bar
 * icon and in the status bar.
 *
 * This is a projection of current state, not a tally of past events, which is
 * what makes it clear itself — the moment the user answers a prompt the row
 * leaves `waiting` and the next snapshot drops the count. `error` is
 * deliberately excluded: it is sticky until the next successful turn, so
 * counting it would pin the indicator for a long time. It shows in the tooltip
 * instead.
 */
export class AttentionIndicator implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem

  constructor(private readonly setViewBadge: (count: number, tooltip: string) => void) {
    this.item = vscode.window.createStatusBarItem(
      'heroCode.attention',
      vscode.StatusBarAlignment.Left,
      100,
    )
    this.item.name = 'Claude Sessions'
    this.item.command = 'workbench.view.extension.hero-code-sessions'
  }

  update(snap: MonitorSnapshot): void {
    const waiting: string[] = []
    const errored: string[] = []
    for (const g of snap.groups) {
      for (const s of g.sessions) {
        if (s.done) {
          continue
        }
        if (s.status === 'waiting') {
          waiting.push(s.customName || s.title)
        } else if (s.status === 'error') {
          errored.push(s.customName || s.title)
        }
      }
    }

    const c = vscode.workspace.getConfiguration('heroCode.notifications')
    const n = waiting.length
    const tooltip = n === 1 ? '1 Claude session waiting for input' : `${n} Claude sessions waiting for input`

    this.setViewBadge(c.get<boolean>('badge', true) ? n : 0, tooltip)

    if (!c.get<boolean>('statusBar', true) || (n === 0 && errored.length === 0)) {
      this.item.hide()
      return
    }
    this.item.text = n > 0 ? `$(bell-dot) ${n}` : '$(warning) Claude'
    this.item.backgroundColor =
      n > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    const lines = [
      ...waiting.map((t) => `- Waiting: ${t}`),
      ...errored.map((t) => `- Error: ${t}`),
    ]
    this.item.tooltip = new vscode.MarkdownString(lines.join('\n'))
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
  }
}
