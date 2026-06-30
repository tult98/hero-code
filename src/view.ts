import * as vscode from 'vscode'
import { getSessionGroups } from './sessions.js'

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.sessions'

  private view?: vscode.WebviewView
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly extensionUri: vscode.Uri) {}

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
    view.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg.type === 'ready') {
        this.postState()
      }
    })

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
    this.view?.webview.postMessage({ type: 'state', groups: getSessionGroups() })
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
