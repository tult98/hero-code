import * as vscode from 'vscode'
import { SessionsViewProvider } from './view.js'
import { SessionMonitor } from './monitor.js'
import { TransitionDetector } from './events.js'
import { AttentionIndicator, Notifier } from './notify.js'
import { openSessionAnywhere } from './open.js'
import { initTerminals, mentionInSessionTerminal } from './terminal.js'
import { ChatSessionManager } from './chat/manager.js'
import { ChatView } from './chat/view.js'

/** Focuses the Claude Sessions sidebar — the way back from a native banner. */
const REVEAL_SIDEBAR = 'workbench.view.extension.hero-code-sessions'

export function activate(context: vscode.ExtensionContext) {
  // Re-adopt any terminals VS Code restored from before a window reload, before
  // the view can post its first click, so reveals hit the existing terminal
  // rather than spawning a duplicate. Also readies the tmux host that lets a
  // single terminal switch between sessions.
  initTerminals(context)

  // The GUI chat engine: one shared docked chat view, driven by SDK sessions.
  // The view is created first so the manager can emit events straight into it.
  const chatView = new ChatView(context.extensionUri)
  const chatManager = new ChatSessionManager((event) => chatView.handleEvent(event), context.extensionUri.fsPath)
  chatView.attach(chatManager)

  // The always-on session scan. It deliberately does not belong to the sidebar:
  // everything below only works because state keeps being derived while no view
  // is open, which is exactly when a notification is worth sending.
  const monitor = new SessionMonitor(context.globalState, chatManager)

  const provider = new SessionsViewProvider(context.extensionUri, monitor, chatManager, chatView)

  const detector = new TransitionDetector(chatManager)
  const notifier = new Notifier(
    () => monitor.snapshot,
    () => provider.visible,
    (id) => chatView.showingSession(id),
    (e) => {
      void vscode.commands.executeCommand(REVEAL_SIDEBAR)
      openSessionAnywhere(chatManager, chatView, e.id, e.title, e.liveId, e.folderPath)
    },
    () => void vscode.commands.executeCommand(REVEAL_SIDEBAR),
  )
  const indicator = new AttentionIndicator((count, tooltip) => provider.setBadge(count, tooltip))

  monitor.onDidChange((snap) => {
    indicator.update(snap)
    notifier.push(detector.detect(snap))
  })

  context.subscriptions.push(
    monitor,
    notifier,
    indicator,
    vscode.window.registerWebviewViewProvider(
      SessionsViewProvider.viewType,
      provider,
    ),
    // The chat view. `retainContextWhenHidden` keeps the conversation mounted
    // when the view is collapsed or hidden; VS Code recreates the view itself
    // after a window reload (no serializer needed).
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('hero-code.mentionInSession', () =>
      mentionInSession(provider, chatManager, chatView),
    ),
    // Tear down SDK subprocesses when the extension unloads.
    { dispose: () => chatManager.disposeAll() },
  )
}

/**
 * Insert an `@file` mention for the active editor into the currently-selected
 * session, without submitting it. Routes to the chat input when that session is
 * chat-owned, otherwise to its terminal. With a selection, the mention carries
 * the line range (`@path#L10-20`); with an empty selection it references the
 * whole file (`@path`).
 */
function mentionInSession(provider: SessionsViewProvider, chat: ChatSessionManager, chatView: ChatView) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage(
      'Open a file to mention it in a Claude session.',
    )
    return
  }

  const sessionId = provider.selectedSessionId
  if (!sessionId) {
    vscode.window.showWarningMessage('Select a Claude session first.')
    return
  }

  const rel = vscode.workspace.asRelativePath(editor.document.uri, false)
  const sel = editor.selection
  let mention: string
  if (sel.isEmpty) {
    mention = `@${rel} `
  } else {
    // A full-line selection often ends at column 0 of the following line; pull
    // it back so selecting lines 40–58 yields `#L40-58`, not `#L40-59`.
    let endLine = sel.end.line
    if (sel.end.character === 0 && endLine > sel.start.line) {
      endLine--
    }
    const start = sel.start.line + 1
    const end = endLine + 1
    mention =
      start === end ? `@${rel}#L${start} ` : `@${rel}#L${start}-${end} `
  }

  if (chat.has(sessionId)) {
    chatView.mention(sessionId, mention)
  } else if (!mentionInSessionTerminal(sessionId, mention)) {
    vscode.window.showWarningMessage(
      'The selected session has no open terminal.',
    )
  }
}

export function deactivate() {}
