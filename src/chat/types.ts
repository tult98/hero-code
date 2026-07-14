/**
 * Types for the GUI chat window: the rendered chat model (shared between the
 * host-side session manager and the chat webview) and the message protocol that
 * bridges them. The sidebar's own types live in `../types.ts` and are unchanged.
 */

/** Live state of a chat session, mirrored into the panel header/input. */
export type ChatStatus = 'idle' | 'streaming' | 'awaiting-permission' | 'error'

export interface ChatTextBlock {
  type: 'text'
  text: string
}

/** A tool call the assistant made, rendered as a card with its lifecycle. */
export interface ChatToolUseBlock {
  type: 'tool_use'
  /** Anthropic tool_use id — used to attach the matching tool_result. */
  id: string
  name: string
  /** Short human label, e.g. `Read · foo.ts` (from `describeTool`). */
  label: string
  input: unknown
  /**
   * pending → awaiting a permission decision; allowed/denied → user's choice;
   * done → a tool_result came back; error → the tool_result was an error.
   */
  status: 'pending' | 'allowed' | 'denied' | 'done' | 'error'
  /** tool_result text once the tool has run (trimmed for display). */
  result?: string
}

export type ChatBlock = ChatTextBlock | ChatToolUseBlock

export interface ChatMessage {
  /** Stable id (message uuid, or synthesized for history/user turns). */
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
}

/** A parked tool-permission prompt awaiting the user's Approve/Deny. */
export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  /** Full prompt sentence from the SDK bridge, when present. */
  title?: string
  /** Short noun phrase for the action, suitable for a compact header. */
  displayName?: string
  input: unknown
}

/** Host → chat webview. */
export type ChatOutbound =
  | { type: 'hydrate'; sessionId: string; title: string; messages: ChatMessage[]; status: ChatStatus; permission?: PermissionRequest }
  | { type: 'append'; sessionId: string; message: ChatMessage }
  | { type: 'update'; sessionId: string; message: ChatMessage }
  | { type: 'status'; sessionId: string; status: ChatStatus }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permissionResolved'; sessionId: string; requestId: string }
  | { type: 'mention'; sessionId: string; text: string }

/** Chat webview → host. */
export type ChatInbound =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'permissionResponse'; sessionId: string; requestId: string; allow: boolean }
  | { type: 'interrupt'; sessionId: string }
