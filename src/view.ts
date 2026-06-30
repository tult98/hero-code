import * as vscode from 'vscode'
import type { SessionGroup, SessionItem, Status } from './types.js'
import { getSessionGroups } from './sessions.js'
import { escapeHtml, relativeTime } from './format.js'
import { PANEL_CSS } from './styles.js'

const STATUS_LABEL: Record<Status, string> = {
  working: 'Working',
  waiting: 'Waiting',
  error: 'Error',
  idle: 'Idle',
}

/**
 * Codicon name per status, rendered as `<span class="codicon codicon-<name>">`.
 * `working` additionally gets `codicon-modifier-spin` for the animated loader.
 */
const STATUS_ICON: Record<Status, string> = {
  working: 'loading',
  waiting: 'circle-filled',
  error: 'error',
  idle: 'circle-outline',
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.sessions'

  private view?: vscode.WebviewView
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: false,
      // Allow the webview to load the bundled codicon font from `dist/`.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    this.render()

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.render()
      }
    })

    // Auto-refresh: re-scan the session files while the panel is visible.
    this.timer = setInterval(() => {
      if (this.view?.visible) {
        this.render()
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

  private render(): void {
    if (!this.view) {
      return
    }
    const { webview } = this.view
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'))
    webview.html = this.html(getSessionGroups(), codiconUri.toString(), webview.cspSource)
  }

  private row(item: SessionItem, now: number): string {
    const time = relativeTime(now - item.mtime)
    const branch = item.branch
      ? `<div class="branch"><span class="codicon codicon-git-branch"></span><span class="branch-name">${escapeHtml(item.branch)}</span></div>`
      : ''
    const activity = item.activity ? `<div class="activity">${escapeHtml(item.activity)}</div>` : ''
    const spin = item.status === 'working' ? ' codicon-modifier-spin' : ''
    const indicator = `<span class="codicon codicon-${STATUS_ICON[item.status]}${spin}" title="${STATUS_LABEL[item.status]}"></span>`

    return `<li class="session ${item.status}">
			<div class="ind">${indicator}</div>
			<div class="body">
				<div class="head">
					<span class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
					<span class="time">${time}</span>
				</div>
				${branch}
				${activity}
			</div>
		</li>`
  }

  private group(g: SessionGroup, now: number): string {
    const body = g.sessions.length
      ? `<ul>${g.sessions.map((i) => this.row(i, now)).join('')}</ul>`
      : '<div class="group-empty">No sessions yet.</div>'

    return `<div class="group">
		<div class="group-head">
			<span class="codicon codicon-triangle-down chevron"></span>
			<span class="group-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
			<span class="group-actions"><span class="codicon codicon-add" title="New session in workspace"></span></span>
		</div>
		${body}
	</div>`
  }

  private html(groups: SessionGroup[], codiconUri: string, cspSource: string): string {
    const now = Date.now()
    const body = groups.length
      ? groups.map((g) => this.group(g, now)).join('')
      : '<div class="empty">No workspace open.</div>'

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
<link href="${codiconUri}" rel="stylesheet" />
<style>${PANEL_CSS}</style>
</head>
<body>
	<div class="panel">
		<div class="header">
			<span>SESSIONS</span>
			<span class="header-actions"><span class="codicon codicon-refresh" title="Refresh"></span><span class="codicon codicon-ellipsis" title="More"></span></span>
		</div>
		<div class="list">${body}</div>
	</div>
</body>
</html>`
  }
}
