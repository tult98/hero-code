import type { ChatInbound } from '../../chat/types.js'

interface VsCodeApi {
  postMessage(message: ChatInbound): void
}

declare function acquireVsCodeApi(): VsCodeApi

// `acquireVsCodeApi` may only be called once per webview load, so grab it here
// and share the single handle.
export const vscode = acquireVsCodeApi()
