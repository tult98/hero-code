import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { encodeProjectPath } from './transcript.js'

/** One terminal per session id, kept alive; clicking a row reveals its terminal. */
const terminals = new Map<string, vscode.Terminal>()

/** Dock the terminal panel to the right only once, on the first open. */
let panelDockedRight = false

/** Register the close listener exactly once, lazily on first use. */
let closeListenerRegistered = false

function ensureCloseListener(): void {
  if (closeListenerRegistered) {
    return
  }
  closeListenerRegistered = true
  // Drop the map entry when its terminal is closed, so a reused id never points
  // at a disposed terminal.
  vscode.window.onDidCloseTerminal((closed) => {
    for (const [id, term] of terminals) {
      if (term === closed) {
        terminals.delete(id)
        break
      }
    }
  })
}

/**
 * Locate the workspace folder a session belongs to by finding which open
 * folder's transcript directory contains `<sessionId>.jsonl`. Returns the
 * folder's filesystem path, or undefined if no open folder owns the session.
 */
function findSessionCwd(sessionId: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  for (const folder of folders) {
    const file = path.join(
      os.homedir(),
      '.claude',
      'projects',
      encodeProjectPath(folder.uri.fsPath),
      `${sessionId}.jsonl`,
    )
    if (fs.existsSync(file)) {
      return folder.uri.fsPath
    }
  }
  return undefined
}

/**
 * Resume a Claude session in an integrated terminal. Each session keeps its own
 * terminal alive; if one is already open this just reveals it (the panel shows a
 * single terminal at a time, so this swaps which one is displayed). Otherwise it
 * opens a new terminal in the panel and runs `claude --resume <sessionId>` in the
 * session's workspace folder. The panel is docked to the right on first use so it
 * reads like a right-hand sidebar.
 */
export function openSessionTerminal(sessionId: string, title?: string): void {
  ensureCloseListener()

  const existing = terminals.get(sessionId)
  if (existing) {
    existing.show()
    return
  }

  const cwd = findSessionCwd(sessionId)
  if (!cwd) {
    void vscode.window.showWarningMessage(
      `Could not locate the workspace folder for this session, so it can't be resumed.`,
    )
    return
  }

  if (!panelDockedRight) {
    panelDockedRight = true
    void vscode.commands.executeCommand('workbench.action.positionPanelRight')
  }

  const terminal = vscode.window.createTerminal({
    name: title || `Claude ${sessionId.slice(0, 8)}`,
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  terminals.set(sessionId, terminal)
  terminal.sendText(`claude --resume ${sessionId}`, true)
  terminal.show()
}

/**
 * Start a fresh Claude session in an integrated terminal rooted at `cwd` (a
 * workspace folder). Unlike `openSessionTerminal`, these terminals aren't
 * tracked or reused: each click opens a genuinely new session. The panel is
 * docked to the right on first use, matching the resume flow.
 */
export function openNewSessionTerminal(cwd: string): void {
  if (!panelDockedRight) {
    panelDockedRight = true
    void vscode.commands.executeCommand('workbench.action.positionPanelRight')
  }

  const terminal = vscode.window.createTerminal({
    name: `Claude (${path.basename(cwd)})`,
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  terminal.sendText('claude', true)
  terminal.show()
}
