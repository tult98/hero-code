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

/**
 * Live per-session facts shown in the composer footer, pulled from the session's
 * own SDK stream / control API (not the transcript). All optional: each fills in
 * as the SDK reports it (model + mode from the init message, context % from
 * `getContextUsage`, branch computed from the cwd).
 */
export interface ChatMeta {
  /** Raw model id, e.g. `claude-opus-4-8`. */
  model?: string
  /** `default` | `acceptEdits` | `plan` | `auto` | `bypassPermissions`. */
  permissionMode?: string
  /** Git branch of the session cwd, e.g. `main`. */
  branch?: string
  /** Percent of the context window used, 0–100. */
  contextPercent?: number
}

/**
 * A pasted/dropped image attached to a user turn. The `[Image #N]` token shown in
 * the composer is plain text in the turn; the bytes travel here and are sent to
 * the SDK as a base64 image content block.
 */
export interface ChatImageAttachment {
  /** IANA media type, e.g. `image/png`. */
  mediaType: string
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string
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
  | { type: 'hydrate'; sessionId: string; title: string; messages: ChatMessage[]; status: ChatStatus; permission?: PermissionRequest; meta?: ChatMeta }
  | { type: 'append'; sessionId: string; message: ChatMessage }
  | { type: 'update'; sessionId: string; message: ChatMessage }
  | { type: 'status'; sessionId: string; status: ChatStatus }
  | { type: 'meta'; sessionId: string; meta: ChatMeta }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permissionResolved'; sessionId: string; requestId: string }
  | { type: 'mention'; sessionId: string; text: string }

/** Chat webview → host. */
export type ChatInbound =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string; images?: ChatImageAttachment[] }
  | { type: 'permissionResponse'; sessionId: string; requestId: string; allow: boolean }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'cycleMode'; sessionId: string }
