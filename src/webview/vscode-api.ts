import type { SessionGroup } from '../types.js'

/** Shape of the data we persist via the webview state API across reloads. */
export interface PersistedState {
  groups: SessionGroup[]
  /** Names of groups the user has collapsed. */
  collapsed: string[]
  /** Id of the currently selected session row, if any. */
  selectedId?: string | null
}

interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): PersistedState | undefined
  setState(state: PersistedState): void
}

declare function acquireVsCodeApi(): VsCodeApi

// `acquireVsCodeApi` may only be called once per webview load, so grab it here
// and share the single handle.
export const vscode = acquireVsCodeApi()
