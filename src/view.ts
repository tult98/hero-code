import * as vscode from 'vscode'
import type { SessionMeta } from './types.js'
import { getSessionGroups } from './sessions.js'
import { openSessionTerminal } from './terminal.js'

/** `globalState` key under which per-session user metadata is stored. */
const META_KEY = 'hero-code.sessionMeta'

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.sessions'

  private view?: vscode.WebviewView
  private timer?: ReturnType<typeof setInterval>

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
        title?: string
        name?: string
        pinned?: boolean
        done?: boolean
      }) => {
        if (msg.type === 'ready' || msg.type === 'refresh') {
          this.postState()
        } else if (msg.type === 'open' && msg.id) {
          openSessionTerminal(msg.id, msg.title)
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

    view.onDidDispose(() => {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
      this.view = undefined
    })
  }

  private postState(): void {
    this.view?.webview.postMessage({ type: 'state', groups: getSessionGroups(this.getMeta()) })
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
