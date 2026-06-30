import * as vscode from 'vscode'
import { SessionsViewProvider } from './view.js'

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionsViewProvider.viewType,
      new SessionsViewProvider(context.extensionUri),
    ),
  )
}

export function deactivate() {}
