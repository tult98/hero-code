import * as vscode from 'vscode'
import { openSessionTerminal } from './terminal.js'
import type { ChatSessionManager } from './chat/manager.js'
import type { ChatView } from './chat/view.js'

/** Whether new/idle sessions open in the GUI chat instead of a terminal. */
export function isChatMode(): boolean {
  return vscode.workspace.getConfiguration('heroCode').get<string>('newSessionMode') === 'chat'
}

/**
 * Reveal a session wherever it lives. In terminal mode, always a terminal. In
 * chat mode, a chat-owned session is revealed directly and any other session is
 * resumed in an SDK-driven chat; the terminal is the fallback when the session's
 * folder is unknown, since we can't seed an SDK resume without a cwd.
 *
 * Lives here rather than on the view because both the sidebar's click handler
 * and a notification's "Open" button need it, and the two must behave
 * identically — a notification that opened a session differently from a click
 * would be its own bug.
 */
export function openSessionAnywhere(
  chat: ChatSessionManager,
  chatView: ChatView,
  id: string,
  title?: string,
  liveId?: string,
  folderPath?: string,
): void {
  if (!isChatMode()) {
    openSessionTerminal(id, title, liveId)
    return
  }
  // After `/clear` the live conversation lives under `liveId`; that's what the
  // chat resumes and keys on.
  const target = liveId || id
  if (chat.has(target)) {
    chatView.show(target)
  } else if (folderPath) {
    void chat
      .resume(target, folderPath)
      .then((sid) => chatView.show(sid))
      .catch((e) =>
        vscode.window.showErrorMessage(`Could not open chat: ${e instanceof Error ? e.message : e}`),
      )
  } else {
    openSessionTerminal(id, title, liveId)
  }
}
