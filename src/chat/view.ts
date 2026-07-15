import * as vscode from 'vscode'
import * as path from 'path'
import type { ChatSessionManager } from './manager.js'
import type { ChatInbound, ChatOutbound, FileHit } from './types.js'

/**
 * The single, reusable GUI chat window, implemented as a `WebviewView` so it
 * docks like a side panel (and can be dragged to the Secondary Side Bar to sit
 * on the right, where it sticks) rather than floating as an editor tab. It shows
 * one session at a time; switching sessions in the sidebar calls
 * {@link ChatView.show}, which reveals the view and hydrates it from the
 * {@link ChatSessionManager}. Live manager events are forwarded to the webview
 * only while their session is the active one; a session switched away from is
 * replayed in full on the next `show`.
 */
export class ChatView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hero-code.chat'

  private view?: vscode.WebviewView
  private activeId?: string
  private manager?: ChatSessionManager

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Wire the session manager (constructed after the view to share its emitter). */
  attach(manager: ChatSessionManager): void {
    this.manager = manager
  }

  /** VS Code calls this when the view first becomes visible, and after reload. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    view.webview.html = this.shellHtml(view.webview)
    view.webview.onDidReceiveMessage((msg: ChatInbound) => this.onMessage(msg))
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined
      }
    })
    // Replay the active session once the webview (re)appears.
    this.hydrate()
  }

  /** Reveal the chat view showing `sessionId`, hydrating it from the manager. */
  show(sessionId: string): void {
    this.activeId = sessionId
    // Focus reveals the view (opening its side bar if collapsed); if it isn't
    // resolved yet, this triggers resolveWebviewView, which hydrates.
    void vscode.commands.executeCommand(`${ChatView.viewType}.focus`)
    this.hydrate()
  }

  /** Insert an `@file` mention into the input if that session is showing. */
  mention(sessionId: string, text: string): void {
    if (this.view && this.activeId === sessionId) {
      // Reveal + focus the view so the caret lands in the composer (the webview's
      // `mention` handler focuses the textarea once the view has focus).
      this.view.show(false)
      this.post({ type: 'mention', sessionId, text })
    }
  }

  /** Route a manager event to the webview when it concerns the active session. */
  handleEvent(event: ChatOutbound): void {
    if (!this.view) {
      return
    }
    const sessionId = event.type === 'permission' ? event.request.sessionId : event.sessionId
    if (sessionId !== this.activeId) {
      return
    }
    this.post(event)
  }

  // --- internals -----------------------------------------------------------

  private onMessage(msg: ChatInbound): void {
    const manager = this.manager
    if (!manager) {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.hydrate()
        return
      case 'send':
        manager.send(msg.sessionId, msg.text, msg.images)
        return
      case 'runCommand':
        manager.runCommand(msg.sessionId, msg.command)
        return
      case 'permissionResponse':
        manager.respondPermission(msg.requestId, msg.allow)
        return
      case 'interrupt':
        manager.interrupt(msg.sessionId)
        return
      case 'cycleMode':
        manager.cycleMode(msg.sessionId)
        return
      case 'listCommands':
        void this.sendCommands(msg.sessionId)
        return
      case 'searchFiles':
        void this.sendFileResults(msg.sessionId, msg.query)
        return
    }
  }

  /** Answer the composer's `/` menu with the session's skills + slash commands. */
  private async sendCommands(sessionId: string): Promise<void> {
    if (!this.manager) {
      return
    }
    const commands = await this.manager.listCommands(sessionId)
    if (this.activeId === sessionId) {
      this.post({ type: 'commands', sessionId, commands })
    }
  }

  /** Answer the composer's `@` menu with ranked workspace files for `query`. */
  private async sendFileResults(sessionId: string, query: string): Promise<void> {
    const cwd = this.manager?.cwdOf(sessionId)
    if (!cwd) {
      return
    }
    const results = await searchWorkspaceFiles(cwd, query)
    // Drop responses for a session that is no longer the active one; the webview
    // additionally checks the `query` tag to ignore out-of-order results.
    if (this.activeId === sessionId) {
      this.post({ type: 'fileResults', sessionId, query, results })
    }
  }

  /** Push the active session's full state to the webview. */
  private hydrate(): void {
    if (!this.view || !this.activeId || !this.manager) {
      return
    }
    const snap = this.manager.snapshot(this.activeId)
    if (!snap) {
      return
    }
    this.view.title = snap.title || 'Chat'
    this.post({
      type: 'hydrate',
      sessionId: this.activeId,
      title: snap.title,
      messages: snap.messages,
      status: snap.status,
      permission: snap.permission,
      meta: snap.meta,
    })
  }

  private post(event: ChatOutbound): void {
    void this.view?.webview.postMessage(event)
  }

  private shellHtml(webview: vscode.Webview): string {
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', ...p))
    const nonce = getNonce()
    // Cache-bust the bundle + stylesheet: VS Code caches webview resources by
    // URL, so without a changing query a rebuilt dist/ won't load on reload.
    const scriptUri = `${uri('chat.js')}?v=${nonce}`
    const styleUri = `${uri('webview.css')}?v=${nonce}`
    const codiconUri = uri('codicon.css')
    const cspSource = webview.cspSource
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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

/**
 * Rank workspace files under `cwd` for the composer's `@` menu. `findFiles`
 * honours `files.exclude` / `search.exclude` / `.gitignore` and is scoped to the
 * session folder via a `RelativePattern`; results are then fuzzily ordered by how
 * well each basename/path matches `query`. An empty query returns the first files.
 */
async function searchWorkspaceFiles(cwd: string, query: string, limit = 50): Promise<FileHit[]> {
  const pattern = new vscode.RelativePattern(cwd, '**/*')
  const uris = await vscode.workspace.findFiles(pattern, undefined, 4000)
  const q = query.toLowerCase()
  const scored: { hit: FileHit; score: number }[] = []
  for (const uri of uris) {
    const rel = path.relative(cwd, uri.fsPath).split(path.sep).join('/')
    if (!rel || rel.startsWith('..')) {
      continue
    }
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const score = scoreFileMatch(name.toLowerCase(), rel.toLowerCase(), q)
    if (score < 0) {
      continue
    }
    scored.push({ hit: { rel, name }, score })
  }
  scored.sort((a, b) => b.score - a.score || a.hit.rel.length - b.hit.rel.length)
  return scored.slice(0, limit).map((s) => s.hit)
}

/** Match score for a file: basename-prefix > basename-substring > path-substring > fuzzy subsequence; -1 = no match. */
function scoreFileMatch(name: string, rel: string, q: string): number {
  if (q === '') {
    return 0
  }
  if (name.startsWith(q)) {
    return 4
  }
  if (name.includes(q)) {
    return 3
  }
  if (rel.includes(q)) {
    return 2
  }
  return isSubsequence(q, rel) ? 1 : -1
}

/** True if every char of `q` appears in `text` in order (fuzzy match). */
function isSubsequence(q: string, text: string): boolean {
  let i = 0
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) {
      i++
    }
  }
  return i === q.length
}

/** Random nonce so the webview script satisfies the CSP. */
function getNonce(): string {
  let text = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
