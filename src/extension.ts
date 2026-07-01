import * as vscode from 'vscode'
import { SessionsViewProvider } from './view.js'
import { reconnectTerminals } from './terminal.js'

export function activate(context: vscode.ExtensionContext) {
  // Re-adopt any terminals VS Code restored from before a window reload, before
  // the view can post its first click, so reveals hit the existing terminal
  // rather than spawning a duplicate.
  reconnectTerminals()

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionsViewProvider.viewType,
      new SessionsViewProvider(context.extensionUri, context.globalState),
    ),
  )
}

export function deactivate() {}
