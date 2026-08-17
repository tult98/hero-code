import * as vscode from 'vscode'
import { randomUUID } from 'crypto'
import type { SessionMeta } from './types.js'
import type { MonitorSnapshot, SessionMonitor } from './monitor.js'
import { openNewSessionTerminal, openSessionTerminal } from './terminal.js'

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.sessions'

  private view?: vscode.WebviewView
  private configListener?: vscode.Disposable
  private monitorSub?: vscode.Disposable
  /** Session id to select on the next posted state, consumed once. */
  private selectOnce?: string
  /**
   * Id of the session currently selected in the sidebar, mirrored from the
   * webview's `open`/`newSession` messages so host-side commands (e.g. the
   * "mention in session" keybinding) know which terminal to target. Resets on
   * window reload, which is why that command warns when it is undefined.
   */
  private selected?: string

  /** Id of the session currently selected in the sidebar, if any. */
  get selectedSessionId(): string | undefined {
    return this.selected
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly monitor: SessionMonitor,
  ) {}

  /** Whether the sidebar is currently on screen. */
  get visible(): boolean {
    return this.view?.visible === true
  }

  /**
   * Show a count of sessions needing attention on the activity-bar icon. Only
   * possible once the view has been resolved — the status-bar item covers the
   * window-reload case where the user has not opened the sidebar yet.
   */
  setBadge(count: number, tooltip: string): void {
    if (this.view) {
      this.view.badge = count > 0 ? { value: count, tooltip } : undefined
    }
  }

  /**
   * Open a session from outside the webview — a notification's "Open" button —
   * and make the sidebar highlight its row.
   *
   * A click that starts *in* the webview needs none of this: the React app has
   * already moved its own selection by the time the `open` message arrives. A
   * host-driven open has no such echo, so without this the terminal appears but
   * the sidebar still points at whatever was selected before, and the "mention
   * in session" keybinding keeps targeting the wrong session.
   */
  revealSession(id: string, title?: string, liveId?: string): void {
    this.selected = id
    this.selectOnce = id
    openSessionTerminal(id, title, liveId)
    if (this.view?.visible) {
      this.post(this.monitor.snapshot)
    }
    // When the sidebar is closed or hidden there is nothing to post to yet.
    // `selectOnce` stays pending, and the reveal the caller triggers lands it on
    // the webview's `ready` (fresh mount) or its visibility change (existing one).
  }

  /** Persist a metadata patch for one session; the monitor re-scans and re-posts. */
  private setMeta(id: string, patch: SessionMeta): void {
    this.monitor.setMeta(id, patch)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      // Allow the webview to load the bundled React app, codicon stylesheet, and
      // font from `dist/`.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }

    // The HTML shell is set exactly once; from here on the React app owns the DOM
    // and we only push fresh session data over `postMessage`.
    view.webview.html = this.shellHtml(view.webview)

    // The bundle loads asynchronously, so a state message posted now could arrive
    // before the webview attaches its listener. The app posts `ready` once mounted
    // (and again after any reload), and we reply with the current state.
    view.webview.onDidReceiveMessage(
      (msg: {
        type?: string
        id?: string
        liveId?: string
        title?: string
        name?: string
        path?: string
        running?: boolean
        pinned?: boolean
        done?: boolean
      }) => {
        if (msg.type === 'ready' || msg.type === 'refresh') {
          this.post(this.monitor.snapshot)
        } else if (msg.type === 'open' && msg.id) {
          this.selected = msg.id
          openSessionTerminal(msg.id, msg.title, msg.liveId)
        } else if (msg.type === 'newSession' && msg.path) {
          const id = randomUUID()
          openNewSessionTerminal(msg.path, id)
          this.monitor.addPending(id, msg.path)
          this.selectOnce = id
          this.selected = id
          this.monitor.refresh()
        } else if (msg.type === 'pin' && msg.id) {
          this.setMeta(msg.id, { pinned: msg.pinned })
        } else if (msg.type === 'rename' && msg.id) {
          this.setMeta(msg.id, { name: msg.name })
        } else if (msg.type === 'done' && msg.id) {
          this.setMeta(msg.id, { done: msg.done })
        }
      },
    )

    // The monitor scans regardless of visibility; we only render when on screen.
    // It re-scans on reveal, so a sidebar opened after a long absence never
    // shows a stale snapshot.
    this.monitorSub?.dispose()
    this.monitorSub = this.monitor.onDidChange((snap) => {
      if (this.view?.visible) {
        this.post(snap)
      }
    })

    view.onDidChangeVisibility(() => {
      this.monitor.setViewVisible(view.visible)
      if (view.visible) {
        this.post(this.monitor.snapshot)
      }
    })

    // Apply a debug-mode toggle immediately rather than waiting for the next poll.
    this.configListener?.dispose()
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('heroCode.debugMode') && this.view?.visible) {
        this.post(this.monitor.snapshot)
      }
    })

    view.onDidDispose(() => {
      this.monitorSub?.dispose()
      this.monitorSub = undefined
      this.configListener?.dispose()
      this.configListener = undefined
      this.view = undefined
      this.monitor.setViewVisible(false)
    })

    this.monitor.setViewVisible(view.visible)
  }

  /** Render a snapshot. All derivation happens in the monitor; this only ships it. */
  private post(snap: MonitorSnapshot): void {
    const view = this.view
    if (!view) {
      // Nothing to post to. Leave `selectOnce` pending rather than consuming it
      // into a dropped message — the next post, once a webview exists, needs it.
      return
    }
    const selectId = this.selectOnce
    this.selectOnce = undefined
    const debug = vscode.workspace.getConfiguration('heroCode').get<boolean>('debugMode', false)
    void view.webview.postMessage({
      type: 'state',
      groups: snap.groups,
      debug,
      ...(selectId ? { selectId } : {}),
    })
  }

  private shellHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'))
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const cspSource = webview.cspSource

    // codicon.css first, then the Tailwind bundle so its utilities win over the
    // codicon base rules (e.g. icon font-size) on equal specificity.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link href="${codiconUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

/** Random nonce so the webview script satisfies the webview CSP. */
function getNonce(): string {
  let text = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
