import * as vscode from 'vscode'
import { SessionsViewProvider } from './view.js'
import { mentionInSessionTerminal, reconnectTerminals } from './terminal.js'

export function activate(context: vscode.ExtensionContext) {
  // Re-adopt any terminals VS Code restored from before a window reload, before
  // the view can post its first click, so reveals hit the existing terminal
  // rather than spawning a duplicate.
  reconnectTerminals()

  const provider = new SessionsViewProvider(
    context.extensionUri,
    context.globalState,
  )

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionsViewProvider.viewType,
      provider,
    ),
    vscode.commands.registerCommand('hero-code.mentionInSession', () =>
      mentionInSession(provider),
    ),
  )
}

/**
 * Insert an `@file` mention for the active editor into the terminal of the
 * currently-selected session, without submitting it. With a selection, the
 * mention carries the line range (`@path#L10-20`); with an empty selection it
 * references the whole file (`@path`).
 */
function mentionInSession(provider: SessionsViewProvider) {
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

  if (!mentionInSessionTerminal(sessionId, mention)) {
    vscode.window.showWarningMessage(
      'The selected session has no open terminal.',
    )
  }
}

export function deactivate() {}
