import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { encodeProjectPath } from './transcript.js'

/** One terminal per session id, kept alive; clicking a row reveals its terminal. */
const terminals = new Map<string, vscode.Terminal>()

/**
 * Matches the `[<sessionId>]` marker we append to every terminal name. VS Code
 * restores terminals across a window reload but wipes our in-memory map, and the
 * name is the only thing that survives — so we encode the session id there and
 * parse it back on activation. Requiring a *bracketed full UUID* is what keeps us
 * from adopting a user's own terminal that merely happens to be named "Claude …".
 */
const SID_RE = /\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]/

/** Terminal name = human-friendly label plus the parseable `[<sessionId>]` marker. */
function formatName(label: string, sessionId: string): string {
  return `${label} [${sessionId}]`
}

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
 * Re-adopt terminals that VS Code restored after a window reload. Our tracking
 * map is module state and is wiped on reload, but the terminal panels come back
 * with their names intact; we parse the `[<sessionId>]` marker out of each name
 * and repopulate the map so clicking a session reveals its restored terminal
 * instead of spawning a duplicate. Idempotent — already-tracked ids are skipped —
 * so it's safe to call more than once. Call this once, early, on activation.
 */
export function reconnectTerminals(): void {
  ensureCloseListener()

  let adopted = 0
  for (const term of vscode.window.terminals) {
    const match = SID_RE.exec(term.name)
    if (!match) {
      continue
    }
    const id = match[1].toLowerCase()
    if (terminals.has(id)) {
      // Don't clobber a terminal we're already tracking live.
      continue
    }
    terminals.set(id, term)
    adopted++
  }

  // The restored panel is already docked wherever the user left it, so skip the
  // one-time reposition the next reveal would otherwise trigger.
  if (adopted > 0) {
    panelDockedRight = true
  }
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
    name: formatName(title || `Claude ${sessionId.slice(0, 8)}`, sessionId),
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  terminals.set(sessionId, terminal)
  terminal.sendText(`claude --resume ${sessionId}`, true)
  terminal.show()
}

/**
 * Start a fresh Claude session in an integrated terminal rooted at `cwd` (a
 * workspace folder). The session id is fixed up front via `--session-id` so the
 * terminal is tracked under that id (exactly like a resumed one): clicking the
 * session's row later reveals this terminal instead of spawning a duplicate
 * `--resume` terminal. The panel is docked to the right on first use.
 */
export function openNewSessionTerminal(cwd: string, sessionId: string): void {
  ensureCloseListener()

  if (!panelDockedRight) {
    panelDockedRight = true
    void vscode.commands.executeCommand('workbench.action.positionPanelRight')
  }

  const terminal = vscode.window.createTerminal({
    name: formatName(`Claude (${path.basename(cwd)})`, sessionId),
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  terminals.set(sessionId, terminal)
  terminal.sendText(`claude --session-id ${sessionId}`, true)
  terminal.show()
}

/** Whether a live terminal is currently tracked for `sessionId`. */
export function hasSessionTerminal(sessionId: string): boolean {
  return terminals.has(sessionId)
}
