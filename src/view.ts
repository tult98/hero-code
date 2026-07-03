import * as vscode from 'vscode'
import { randomUUID } from 'crypto'
import type { SessionItem, SessionMeta } from './types.js'
import { getSessionGroups } from './sessions.js'
import { hasSessionTerminal, openNewSessionTerminal, openSessionTerminal } from './terminal.js'

/** `globalState` key under which per-session user metadata is stored. */
const META_KEY = 'hero-code.sessionMeta'

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.sessions'

  private view?: vscode.WebviewView
  private timer?: ReturnType<typeof setInterval>
  private configListener?: vscode.Disposable
  /**
   * New sessions started from the "+" button, keyed by their pre-assigned
   * session id → the folder path they belong to. Shown as optimistic rows until
   * the real transcript appears (or the terminal is closed), so the panel
   * reflects the session immediately instead of waiting for the first message.
   */
  private pending = new Map<string, string>()
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
    private readonly memento: vscode.Memento,
  ) {}

  /** All persisted per-session metadata, keyed by session id. */
  private getMeta(): Record<string, SessionMeta> {
    return this.memento.get<Record<string, SessionMeta>>(META_KEY, {})
  }

  /**
   * Merge a patch into one session's metadata, drop keys that become empty so
   * the store stays tidy, persist, and re-post state so the view updates.
   */
  private setMeta(id: string, patch: SessionMeta): void {
    const all = { ...this.getMeta() }
    const next: SessionMeta = { ...all[id], ...patch }
    if (!next.pinned) {
      delete next.pinned
    }
    if (!next.done) {
      delete next.done
    }
    if (!next.name) {
      delete next.name
    }
    if (Object.keys(next).length === 0) {
      delete all[id]
    } else {
      all[id] = next
    }
    void this.memento.update(META_KEY, all)
    this.postState()
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
        pinned?: boolean
        done?: boolean
      }) => {
        if (msg.type === 'ready' || msg.type === 'refresh') {
          this.postState()
        } else if (msg.type === 'open' && msg.id) {
          this.selected = msg.id
          openSessionTerminal(msg.id, msg.title, msg.liveId)
        } else if (msg.type === 'newSession' && msg.path) {
          const id = randomUUID()
          openNewSessionTerminal(msg.path, id)
          this.pending.set(id, msg.path)
          this.selectOnce = id
          this.selected = id
          this.postState()
        } else if (msg.type === 'pin' && msg.id) {
          this.setMeta(msg.id, { pinned: msg.pinned })
        } else if (msg.type === 'rename' && msg.id) {
          this.setMeta(msg.id, { name: msg.name })
        } else if (msg.type === 'done' && msg.id) {
          this.setMeta(msg.id, { done: msg.done })
        }
      },
    )

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postState()
      }
    })

    // Auto-refresh: re-scan session files while the panel is visible.
    this.timer = setInterval(() => {
      if (this.view?.visible) {
        this.postState()
      }
    }, 5000)

    // Apply a debug-mode toggle immediately rather than waiting for the next poll.
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('heroCode.debugMode') && this.view?.visible) {
        this.postState()
      }
    })

    view.onDidDispose(() => {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
      this.configListener?.dispose()
      this.configListener = undefined
      this.view = undefined
    })
  }

  private postState(): void {
    const groups = getSessionGroups(this.getMeta())

    // Merge optimistic rows for "+"-started sessions whose transcript hasn't
    // been written yet, so they appear (and can be selected) immediately.
    for (const [id, folderPath] of this.pending) {
      if (!hasSessionTerminal(id)) {
        // The terminal was closed before the first message — abandon the row.
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
        title: 'New session',
        mtime: Date.now(),
        running: true,
        status: 'waiting',
      }
      group.sessions.unshift(placeholder)
    }

    const selectId = this.selectOnce
    this.selectOnce = undefined
    const debug = vscode.workspace.getConfiguration('heroCode').get<boolean>('debugMode', false)
    this.view?.webview.postMessage({ type: 'state', groups, debug, ...(selectId ? { selectId } : {}) })
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
