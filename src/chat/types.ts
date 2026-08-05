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
  /**
   * For sub-agent calls (the `Agent` / `Task` tool): the sub-agent's own
   * transcript, rendered nested inside the card. Populated on resume from the
   * `<sessionId>/subagents/agent-*.jsonl` files, and live from SDK messages whose
   * `parent_tool_use_id` points at this block's `id`.
   */
  steps?: ChatMessage[]
  /** Sub-agent kind shown as the card chip, e.g. `code-reviewer` (from `subagent_type` / meta `agentType`). */
  agentType?: string
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
  /** Uncommitted line changes vs HEAD (staged + unstaged), summed across files. */
  loc?: { added: number; removed: number }
  /** Basename of the session cwd, e.g. `hero-code`. Shown next to the branch. */
  folder?: string
  /** Absolute session cwd; used as the folder hover tooltip. */
  cwd?: string
  /** Percent of the context window used, 0–100. */
  contextPercent?: number
  /** Current reasoning effort level (e.g. `high`), when set via the `/model` panel. */
  effort?: string
}

/**
 * One selectable model in the `/model` picker, derived from the SDK's
 * `supportedModels()`. `value` is passed to `setModel`; `resolvedModel` is the
 * canonical wire id used to match the session's live model to a row.
 */
export interface ModelChoice {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  /** Effort levels this model supports (empty when it has none). */
  effortLevels: string[]
}

/** Live connection state of an MCP server (mirrors the SDK's `McpServerStatus.status`). */
export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

/** One tool exposed by an MCP server, with the annotation flags the detail view chips. */
export interface McpToolInfo {
  name: string
  /** From `annotations.readOnly` — tags the tool as read-only. */
  readOnly: boolean
  /** From `annotations.destructive` — tags the tool as destructive. */
  destructive: boolean
}

/**
 * One MCP server row in the `/mcp` panel, derived host-side from the SDK's
 * `mcpServerStatus()` so the panel stays a pure view. `scope`/`scopeLabel`/`scopePath`
 * group and caption rows; `kind` picks the endpoint label (URL / Command / Provider).
 */
export interface McpServerInfo {
  name: string
  status: McpStatus
  /** Raw scope id from the SDK, e.g. `project` / `user` / `claudeai` / `managed` / `local`. */
  scope: string
  /** Human group label, e.g. `Project`. */
  scopeLabel: string
  /** Config location caption, e.g. `./.mcp.json`. */
  scopePath: string
  /** URL-based (sse/http), command-based (stdio), or built-in provider. */
  kind: 'url' | 'cmd' | 'builtin'
  /** URL, command line, or provider string shown under the endpoint label. */
  endpoint: string
  /** Server version from `serverInfo.version`, when connected. */
  version?: string
  /** Error text for `failed` servers (from the SDK). */
  error?: string
  /** Tool count, or `null` while pending / discovering. */
  toolCount: number | null
  tools: McpToolInfo[]
}

/** Action the `/mcp` panel fires on a server (all fire-and-forget, optimistic UI). */
export type McpAction = 'enable' | 'disable' | 'reconnect' | 'authenticate'

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

/**
 * A workspace file/folder match for the composer's `@` file-reference menu. `rel` is
 * the path relative to the session cwd (inserted as `@<rel> `, or `@<rel>/ ` for a
 * folder); `name` is its basename, shown as the primary label. `isDirectory` marks a
 * folder so the menu can show a folder icon and append a trailing slash.
 */
export interface FileHit {
  rel: string
  name: string
  isDirectory?: boolean
}

/**
 * An available skill / slash command for the composer's `/` menu, from the SDK's
 * `supportedCommands()`. `name` has no leading slash; `argumentHint` is a usage hint
 * like `<file>` (empty when the command takes no arguments).
 */
export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
}

/**
 * One selectable choice in an {@link AskQuestionItem}. Mirrors the SDK's
 * `AskUserQuestionInput` option shape; `preview` is optional rich content
 * (e.g. a code/mockup snippet) the design surfaces alongside the choice.
 */
export interface AskQuestionOption {
  label: string
  description?: string
  preview?: string
}

/**
 * One question inside an AskUserQuestion tool call. `multiSelect` chooses radios
 * vs checkboxes; an "Other / type something else" free-text choice is always
 * offered by the picker (the model is told not to add its own).
 */
export interface AskQuestionItem {
  question: string
  /** Short chip label (≤12 chars), e.g. `Priority`. */
  header: string
  multiSelect: boolean
  options: AskQuestionOption[]
}

/**
 * A parked AskUserQuestion tool call awaiting the user's selections. Reuses the
 * same pause-and-resolve machinery as {@link PermissionRequest} (keyed by the
 * tool_use id), but renders the multi-step picker instead of Approve/Deny.
 */
export interface AskQuestionRequest {
  requestId: string
  sessionId: string
  questions: AskQuestionItem[]
}

/** Coarse tool family the approval panel styles itself around. */
export type PermissionKind = 'bash' | 'write' | 'fetch' | 'mcp' | 'plan' | 'generic'

/** Risk band: `high` flips the panel accent red, everything else amber. */
export type PermissionRisk = 'high' | 'med' | 'low'

/**
 * A parked tool-permission prompt awaiting the user's decision. The plain
 * SDK facts (`toolName`/`title`/`displayName`/`input`) are enriched host-side by
 * `describePermission` into the fields the approval panel renders directly, so
 * the panel stays a pure view (mirrors how `AskQuestionItem` is pre-parsed).
 */
export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  /** Full prompt sentence from the SDK bridge, when present. */
  title?: string
  /** Short noun phrase for the action, suitable for a compact header. */
  displayName?: string
  input: unknown
  // --- derived for the approval panel ---
  kind: PermissionKind
  risk: PermissionRisk
  /** Header pill label, e.g. `Bash` / `Write` / `MCP`. */
  badge: string
  /** Codicon class for the badge/command-block icon, e.g. `codicon-terminal`. */
  badgeIcon: string
  /** Risk chip label, e.g. `Destructive` / `Network` / `External`. */
  riskLabel: string
  /** Codicon class for the risk chip, e.g. `codicon-flame`. */
  riskIcon: string
  /** Uppercase label above the command block, e.g. `Bash command`. */
  blockLabel: string
  /** Exact command / path / URL / MCP call shown in the monospace block. */
  command: string
  /** Subtitle under the command (from the SDK bridge's `description`). */
  description?: string
  /** Amber/red warning box text (the SDK's `decisionReason` + `blockedPath`). */
  note?: string
  /** Longer rationale shown on the `^E` explain toggle; affordance hidden when absent. */
  explain?: string
  /** Whether the SDK offered "always allow" suggestions for this call. */
  canAlways: boolean
  /** Scope phrase for the always option, e.g. `this session` / `this project`. */
  alwaysLabel?: string
  /** Raw plan markdown for `kind: 'plan'` (`ExitPlanMode`); rendered instead of the command block. */
  planMarkdown?: string
}

/** Host → chat webview. */
export type ChatOutbound =
  | { type: 'hydrate'; sessionId: string; title: string; messages: ChatMessage[]; status: ChatStatus; permission?: PermissionRequest; question?: AskQuestionRequest; meta?: ChatMeta }
  | { type: 'append'; sessionId: string; message: ChatMessage }
  | { type: 'update'; sessionId: string; message: ChatMessage }
  | { type: 'status'; sessionId: string; status: ChatStatus }
  | { type: 'meta'; sessionId: string; meta: ChatMeta }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permissionResolved'; sessionId: string; requestId: string }
  // AskUserQuestion picker: `askQuestion` opens it with the parsed questions;
  // `askQuestionResolved` clears it (answered elsewhere, session switched, or the
  // SDK auto-continued). Parallels `permission` / `permissionResolved`.
  | { type: 'askQuestion'; request: AskQuestionRequest }
  | { type: 'askQuestionResolved'; sessionId: string; requestId: string }
  | { type: 'mention'; sessionId: string; text: string }
  // Composer autocomplete results. `fileResults` is tagged with the originating
  // `query` so the webview can drop stale/out-of-order responses.
  | { type: 'fileResults'; sessionId: string; query: string; results: FileHit[] }
  | { type: 'commands'; sessionId: string; commands: CommandInfo[] }
  // `/model` picker catalog. `status` drives the panel's ready/empty/error views;
  // `currentValue` marks the live session model, `defaultValue` the saved default.
  | { type: 'models'; sessionId: string; status: 'ready' | 'empty' | 'error'; models: ModelChoice[]; currentValue?: string; defaultValue?: string; error?: string }
  // `/mcp` panel server list. `status` drives the panel's ready/empty/error views;
  // re-sent after an action so the panel reflects the optimistic status flip.
  | { type: 'mcpServers'; sessionId: string; status: 'ready' | 'empty' | 'error'; servers: McpServerInfo[]; error?: string }

/** Chat webview → host. */
export type ChatInbound =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string; images?: ChatImageAttachment[] }
  // Run a raw shell command (composer `!` prefix). Runs in the session's shell +
  // cwd; output is shown in the chat but not sent to Claude.
  | { type: 'runCommand'; sessionId: string; command: string }
  | { type: 'permissionResponse'; sessionId: string; requestId: string; decision: 'yes' | 'always' | 'no'; amend?: string; mode?: 'auto' | 'acceptEdits' }
  // AskUserQuestion answer: `answers` maps each question's text → the chosen
  // answer string (multi-select joined by `, `, custom free-text included).
  // `dismissed` resolves the tool without an answer (composer returns).
  | { type: 'answerQuestion'; sessionId: string; requestId: string; answers: Record<string, string>; dismissed?: boolean }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'cycleMode'; sessionId: string }
  // Composer autocomplete requests (`@` file search, `/` skills+commands).
  | { type: 'searchFiles'; sessionId: string; query: string }
  | { type: 'listCommands'; sessionId: string }
  // `/model` picker: fetch the catalog (`refresh` bypasses the cache) and commit a
  // choice as the new default (persisted, new sessions) or for this session only.
  | { type: 'listModels'; sessionId: string; refresh?: boolean }
  | { type: 'applyModel'; sessionId: string; value: string; effort?: string; scope: 'default' | 'session' }
  | { type: 'listMcp'; sessionId: string; refresh?: boolean }
  | { type: 'mcpAction'; sessionId: string; name: string; action: McpAction }
