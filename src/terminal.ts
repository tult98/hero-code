import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { encodeProjectPath } from './transcript.js'
import {
  attachArgs,
  disableTmux,
  hasSession,
  initTmux,
  killSession,
  listSessions,
  sendKeys,
  terminalEnv,
  tmuxBinary,
  tmuxReady,
} from './tmux.js'
import type { TmuxSession } from './tmux.js'

/**
 * Sessions are hosted one of two ways.
 *
 * The tmux strategy (default, whenever tmux is available) keeps **one** VS Code
 * terminal open at a time: each session runs in a detached tmux session and the
 * terminal is merely an attached client, so switching sessions disposes one
 * client and creates another while every `claude` keeps running in the
 * background — the session you leave is still working when you come back.
 *
 * The legacy strategy (no tmux, or `heroCode.terminalMultiplexer: "off"`) is the
 * original one terminal per session, kept alive forever.
 */

/**
 * Legacy terminals: one per session id. Also holds terminals restored from
 * before this activation that predate tmux. These are **never** disposed by us —
 * each one holds a live `claude` that only the user may close.
 */
const legacy = new Map<string, vscode.Terminal>()

/** The single tmux attach terminal. At most one exists at any time. */
let attached: { id: string; terminal: vscode.Terminal } | undefined

/**
 * Restored terminals whose session is now hosted in tmux — i.e. dead attach
 * clients from before a reload. Left on screen (we never dispose at startup) and
 * replaced the moment the user opens that session again.
 */
const stale = new Map<string, vscode.Terminal>()

/** id -> creation time, for the launch grace window in `hasSessionTerminal`. */
const starting = new Map<string, number>()

/**
 * Matches the `[<sessionId>]` marker we append to every terminal name. VS Code
 * restores terminals across a window reload but wipes our in-memory maps, and the
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

/** A tmux client that dies this fast after launch means tmux itself failed. */
const LAUNCH_FAILURE_MS = 3_000

/** How long a just-created session counts as live before we ask tmux about it. */
const LAUNCH_GRACE_MS = 30_000

function ensureCloseListener(): void {
  if (closeListenerRegistered) {
    return
  }
  closeListenerRegistered = true
  vscode.window.onDidCloseTerminal((closed) => {
    // Drop the map entry when its terminal is closed, so a reused id never points
    // at a disposed terminal.
    for (const [id, term] of legacy) {
      if (term === closed) {
        legacy.delete(id)
        break
      }
    }
    for (const [id, term] of stale) {
      if (term === closed) {
        stale.delete(id)
        break
      }
    }

    if (attached?.terminal !== closed) {
      return
    }
    const { id } = attached
    attached = undefined

    // Detaching (the user closing the terminal, or us swapping sessions) exits
    // the client cleanly, so a non-zero exit right after launch is the signal
    // that tmux couldn't start at all — bad socket dir, unreadable config,
    // version skew. Say so once and fall back for the rest of the window rather
    // than handing out terminals that die on open.
    const code = closed.exitStatus?.code
    const launchedAt = starting.get(id) ?? 0
    starting.delete(id)
    if (code !== undefined && code !== 0 && Date.now() - launchedAt < LAUNCH_FAILURE_MS) {
      disableTmux()
      void vscode.window.showWarningMessage(
        'Hero Code could not start its tmux session; falling back to one terminal per session.',
      )
    }
  })
}

/**
 * Adopt terminals VS Code restored after a window reload and get tmux ready.
 *
 * A restored terminal whose session now lives in tmux is a dead attach client;
 * one whose session tmux has never heard of is a genuine legacy terminal with a
 * live `claude` inside. Either way **nothing is disposed here**: converging on a
 * single terminal happens only as a direct result of a click, so activation
 * never yanks a terminal out from under the user. Call this once, on activation.
 */
export function initTerminals(context: vscode.ExtensionContext): void {
  ensureCloseListener()

  // Snapshot synchronously, before the tmux probe, so a very fast first click
  // can't race adoption.
  const candidates: [string, vscode.Terminal][] = []
  for (const term of vscode.window.terminals) {
    const match = SID_RE.exec(term.name)
    if (match) {
      candidates.push([match[1].toLowerCase(), term])
    }
  }

  // The restored panel is already docked wherever the user left it, so skip the
  // one-time reposition the next reveal would otherwise trigger.
  if (candidates.length > 0) {
    panelDockedRight = true
  }

  // Adopt everything as legacy up front: a click landing before the tmux probe
  // finishes must still reveal the restored terminal instead of spawning a
  // duplicate resume.
  for (const [id, term] of candidates) {
    legacy.set(id, term)
  }

  // Resolving the tmux binary can cost a login-shell probe (~1s), which has no
  // business sitting on the activation path.
  setTimeout(() => {
    initTmux(context)
    if (!tmuxReady()) {
      return
    }
    const live = listSessions()
    // A restored terminal whose session tmux now hosts is a dead attach client
    // from before the reload, not a live legacy terminal. Reclassify it — but
    // leave it on screen; it's replaced when the user next opens that session.
    for (const [id, term] of candidates) {
      if (live.has(id) && legacy.get(id) === term) {
        legacy.delete(id)
        stale.set(id, term)
      }
    }
    reapDeadSessions(live)
  }, 0)
}

/** Foreground commands that mean the pane is idle at a prompt. */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', '-zsh', '-bash'])

/**
 * Drop tmux sessions left behind by a `claude` that has since exited — the pane
 * is just a bare shell prompt nobody is looking at, and without this they'd
 * accumulate one per session forever.
 *
 * Deliberately conservative: only at activation, only when no client is
 * attached, and only when the pane is sitting at a shell. Anything still running
 * (Claude itself, or a command the user started there) is left alone. Reaping on
 * the poll instead would make a pane vanish out from under someone who quit
 * Claude to run `git log`.
 */
function reapDeadSessions(live: Map<string, TmuxSession>): void {
  for (const [id, session] of live) {
    if (!session.attached && SHELL_COMMANDS.has(session.command)) {
      killSession(id)
    }
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

function dockPanelRight(): void {
  if (!panelDockedRight) {
    panelDockedRight = true
    void vscode.commands.executeCommand('workbench.action.positionPanelRight')
  }
}

/**
 * Open (or reveal) the single tmux terminal for `sessionId`, running `claudeCmd`
 * if the tmux session doesn't exist yet. Disposing the previous attach terminal
 * only SIGHUPs its tmux client — that session's `claude` carries on.
 */
function attachTmuxTerminal(sessionId: string, name: string, cwd: string, claudeCmd: string): void {
  if (attached?.id === sessionId) {
    attached.terminal.show()
    return
  }

  dockPanelRight()

  attached?.terminal.dispose()
  stale.get(sessionId)?.dispose()
  stale.delete(sessionId)

  const terminal = vscode.window.createTerminal({
    name,
    shellPath: tmuxBinary(),
    shellArgs: attachArgs(sessionId, cwd, claudeCmd),
    env: terminalEnv(),
    location: vscode.TerminalLocation.Panel,
    // tmux already persists what matters (the `claude` process), so VS Code's
    // own persistence would only contribute zombies: after an app restart it
    // revives the terminal's buffer with a dead process behind it.
    isTransient: true,
  })
  attached = { id: sessionId, terminal }
  starting.set(sessionId, Date.now())
  sessionCache = undefined
  terminal.show()
}

/**
 * Resume a Claude session in the terminal. If it's already the session on
 * screen this just reveals it. Under tmux the panel keeps a single terminal and
 * swaps which session it is attached to; without tmux each session keeps its own
 * terminal, and one that is already open is revealed rather than duplicated.
 */
export function openSessionTerminal(sessionId: string, title?: string, resumeId?: string): void {
  ensureCloseListener()

  // A live legacy terminal is never migrated into tmux — that would kill the
  // `claude` running inside it.
  const existing = legacy.get(sessionId)
  if (existing) {
    existing.show()
    return
  }

  if (attached?.id === sessionId) {
    attached.terminal.show()
    return
  }

  // After `/clear` the row's stable `sessionId` (launch id) has no transcript of
  // its own; the live conversation lives under `resumeId`. Resume and workspace
  // lookup must target that, while the terminal stays tracked under the stable id.
  const target = resumeId || sessionId
  const name = formatName(title || `Claude ${sessionId.slice(0, 8)}`, sessionId)

  if (tmuxReady()) {
    // An existing tmux session ignores cwd and the command, so an unresolvable
    // workspace folder only blocks the case where we'd actually be creating one.
    const cwd = findSessionCwd(target) ?? (hasSession(sessionId) ? os.homedir() : undefined)
    if (cwd === undefined) {
      void vscode.window.showWarningMessage(
        `Could not locate the workspace folder for this session, so it can't be resumed.`,
      )
      return
    }
    attachTmuxTerminal(sessionId, name, cwd, `claude --resume ${target}`)
    return
  }

  const cwd = findSessionCwd(target)
  if (!cwd) {
    void vscode.window.showWarningMessage(
      `Could not locate the workspace folder for this session, so it can't be resumed.`,
    )
    return
  }

  dockPanelRight()

  const terminal = vscode.window.createTerminal({
    name,
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  legacy.set(sessionId, terminal)
  terminal.sendText(`claude --resume ${target}`, true)
  terminal.show()
}

/**
 * Start a fresh Claude session rooted at `cwd` (a workspace folder). The session
 * id is fixed up front via `--session-id` so the session is tracked under that id
 * (exactly like a resumed one): clicking the session's row later reveals it
 * instead of spawning a duplicate `--resume`.
 */
export function openNewSessionTerminal(cwd: string, sessionId: string): void {
  ensureCloseListener()

  const name = formatName(`Claude (${path.basename(cwd)})`, sessionId)

  if (tmuxReady()) {
    attachTmuxTerminal(sessionId, name, cwd, `claude --session-id ${sessionId}`)
    return
  }

  dockPanelRight()

  const terminal = vscode.window.createTerminal({
    name,
    cwd,
    location: vscode.TerminalLocation.Panel,
  })
  legacy.set(sessionId, terminal)
  terminal.sendText(`claude --session-id ${sessionId}`, true)
  terminal.show()
}

/** One tmux round trip per poll tick, however many pending rows there are. */
let sessionCache: { at: number; ids: Map<string, TmuxSession> } | undefined
const CACHE_TTL_MS = 2_000

function cachedSessions(): Map<string, TmuxSession> {
  if (sessionCache && Date.now() - sessionCache.at < CACHE_TTL_MS) {
    return sessionCache.ids
  }
  sessionCache = { at: Date.now(), ids: listSessions() }
  return sessionCache.ids
}

/**
 * Whether a live terminal or tmux session is currently tracked for `sessionId`.
 *
 * In-memory answers come first, and a freshly created session gets a grace
 * window: the caller creates a session and re-renders in the same tick, long
 * before tmux has registered it, and answering "no" there would drop the
 * optimistic row the user just clicked into existence.
 */
export function hasSessionTerminal(sessionId: string): boolean {
  if (legacy.has(sessionId) || attached?.id === sessionId) {
    return true
  }
  const launchedAt = starting.get(sessionId)
  if (launchedAt !== undefined && Date.now() - launchedAt < LAUNCH_GRACE_MS) {
    return true
  }
  return tmuxReady() && cachedSessions().has(sessionId)
}

/**
 * Insert `text` into the session's terminal without submitting it (no trailing
 * newline), then reveal and focus it so the user can keep typing their prompt.
 * Under tmux the text is delivered even when the session isn't the one on
 * screen — we send first, so it's already in Claude's input when the pane
 * repaints on attach. Returns false if the session has no live terminal.
 */
export function mentionInSessionTerminal(sessionId: string, text: string): boolean {
  const existing = legacy.get(sessionId)
  if (existing) {
    existing.sendText(text, false)
    existing.show()
    return true
  }

  if (!tmuxReady() || !hasSession(sessionId)) {
    return false
  }
  if (!sendKeys(sessionId, text)) {
    return false
  }
  if (attached?.id === sessionId) {
    attached.terminal.show()
  } else {
    openSessionTerminal(sessionId)
  }
  return true
}
