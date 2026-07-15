import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import * as vscode from 'vscode'
import type { ChatImageAttachment, ChatMessage, ChatMeta, ChatOutbound, ChatStatus, ChatToolUseBlock, CommandInfo, PermissionRequest } from './types.js'
import { describeTool, encodeProjectPath, lastAssistantModel, parseTranscriptMessages } from '../transcript.js'
import type { ToolInput } from '../types.js'

// Minimal local shapes for the Agent SDK. We deliberately avoid importing the
// SDK's own types: it's an ESM-only package and type-importing it from this CJS
// host requires import attributes the host tsconfig doesn't enable. We only use
// a small, stable surface, so local shapes are simpler and sufficient.
type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type SdkUserMessage = { type: 'user'; message: { role: 'user'; content: string | SdkContentBlock[] }; parent_tool_use_id: null }
type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
type SdkPermissionInfo = { toolUseID?: string; requestId?: string; title?: string; displayName?: string }
type SdkOptions = {
  cwd: string
  permissionMode?: string
  /** Pre-assign the session id for a new session (like `claude --session-id`). */
  sessionId?: string
  resume?: string
  canUseTool?: (toolName: string, input: Record<string, unknown>, opts: SdkPermissionInfo) => Promise<SdkPermissionResult>
  /** Absolute path to the `claude` executable the SDK should drive. */
  pathToClaudeCodeExecutable?: string
}
type SdkMessage = {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  /** system/init and system/status carry these at the top level. */
  model?: string
  permissionMode?: string
  message?: { content?: unknown; model?: string; usage?: unknown }
}
type SdkContextUsage = { percentage?: number; model?: string }
/** SDK `SlashCommand` — covers both built-in slash commands and skills. */
type SdkSlashCommand = { name: string; description?: string; argumentHint?: string; aliases?: string[] }
interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>
  close(): void
  setPermissionMode(mode: string): Promise<void>
  getContextUsage(): Promise<SdkContextUsage>
  /** Available skills + slash commands for the running session. */
  supportedCommands(): Promise<SdkSlashCommand[]>
}
type SdkModule = { query: (params: { prompt: string | AsyncIterable<SdkUserMessage>; options?: SdkOptions }) => SdkQuery }

let sdkPromise: Promise<SdkModule> | undefined

/**
 * Load the Claude Agent SDK. It is ESM-only, so it can't be bundled into our CJS
 * host; esbuild vendors it into `dist/vendor/` (see copyAgentSdk in esbuild.js)
 * and we import it here by an ABSOLUTE file URL built from the extension's install
 * path. A bare specifier would be resolved against `process.cwd()` (the extension
 * host's cwd, not our folder) and fail with `ERR_MODULE_NOT_FOUND`. The
 * `new Function` wrapper hides the `import()` from esbuild so the real dynamic
 * import survives the CJS transform (esbuild would otherwise rewrite it to
 * `require()`, which fails on an ESM package). `sdk.mjs`'s own `import.meta.url`
 * still resolves to itself inside dist/vendor.
 */
function loadSdk(sdkEntry: string): Promise<SdkModule> {
  if (!sdkPromise) {
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<SdkModule>
    sdkPromise = dynamicImport(pathToFileURL(sdkEntry).href)
  }
  return sdkPromise
}

/**
 * Find the `claude` executable to hand the SDK. Returns an absolute path, or the
 * raw `heroCode.claudePath` setting if the user configured one, or undefined.
 */
function findClaudeExecutable(): string | undefined {
  const configured = vscode.workspace.getConfiguration('heroCode').get<string>('claudePath')?.trim()
  if (configured) {
    return configured
  }

  // Absolute install locations. The extension host's PATH is unreliable (GUI
  // launches often lack `~/.local/bin`), so probe the well-known spots directly.
  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.cmd')]
      : [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // Last resort: ask a login shell to resolve `claude` on the user's real PATH.
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-lic', 'command -v claude'], { encoding: 'utf8' }).trim()
    if (out && path.isAbsolute(out) && fs.existsSync(out)) {
      return out
    }
  } catch {
    // No login shell / `claude` not on PATH — fall through.
  }

  return undefined
}

/** A minimal async-iterable queue we can push user turns into over time. */
class PushQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: ((r: IteratorResult<T>) => void)[] = []
  private done = false

  push(value: T): void {
    if (this.done) {
      return
    }
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve({ value, done: false })
    } else {
      this.values.push(value)
    }
  }

  end(): void {
    this.done = true
    let resolve
    while ((resolve = this.resolvers.shift())) {
      resolve({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift()
        if (value !== undefined) {
          return Promise.resolve({ value, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
    }
  }
}

interface PendingPermission {
  request: PermissionRequest
  resolve: (result: SdkPermissionResult) => void
}

interface ChatSession {
  id: string
  cwd: string
  status: ChatStatus
  /** Rendered chat log — replayed to the panel on (re)hydrate. */
  messages: ChatMessage[]
  /** tool_use id → its card, so tool_results and permission decisions update it. */
  toolCards: Map<string, ChatToolUseBlock>
  queue: PushQueue<SdkUserMessage>
  query?: SdkQuery
  pending: Map<string, PendingPermission>
  // --- live footer facts (see ChatMeta) ---
  /** Raw model id from the SDK, e.g. `claude-opus-4-8`. */
  model?: string
  /** Current permission mode; tracked so Shift+Tab can cycle and resume honors it. */
  permissionMode: string
  /** Git branch of `cwd`, computed once at start. */
  branch?: string
  /** Percent of context window used (0–100), refreshed each turn. */
  contextPercent?: number
  /** Cached skills+slash commands (from the SDK), populated on first `/` menu open. */
  commands?: CommandInfo[]
}

/**
 * Owns SDK-driven chat sessions: one long-lived `query()` per session (streaming
 * input mode, so a session takes many turns), the accumulated chat log, and
 * parked tool-permission prompts. Emits {@link ChatOutbound} events; the panel
 * decides which to forward to the webview (only the active session's).
 */
export class ChatSessionManager {
  private sessions = new Map<string, ChatSession>()

  /** Absolute path to the SDK's `sdk.mjs`, resolved from the extension root. */
  private readonly sdkEntry: string
  /** Memoized absolute path to the `claude` executable (see resolveClaudePath). */
  private claudePathCache?: string

  constructor(
    private readonly emit: (event: ChatOutbound) => void,
    extensionPath: string,
  ) {
    this.sdkEntry = path.join(extensionPath, 'dist', 'vendor', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /** Snapshot for hydrating the panel when a session becomes active. */
  snapshot(id: string): { title: string; messages: ChatMessage[]; status: ChatStatus; permission?: PermissionRequest; meta: ChatMeta } | undefined {
    const session = this.sessions.get(id)
    if (!session) {
      return undefined
    }
    const permission = [...session.pending.values()][0]?.request
    return { title: this.titleOf(session), messages: session.messages, status: session.status, permission, meta: this.metaOf(session) }
  }

  /** Working directory of a session (used to scope `@` file search). */
  cwdOf(id: string): string | undefined {
    return this.sessions.get(id)?.cwd
  }

  /**
   * Available skills + slash commands for a session, for the composer's `/` menu.
   * The first non-empty result is cached on the session; an empty result (SDK not
   * yet initialized, or an older CLI without the control request) is not cached, so
   * a later call retries once commands become available.
   */
  async listCommands(id: string): Promise<CommandInfo[]> {
    const session = this.sessions.get(id)
    if (!session?.query) {
      return []
    }
    if (session.commands) {
      return session.commands
    }
    try {
      const raw = await session.query.supportedCommands()
      const commands = raw.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        argumentHint: c.argumentHint ?? '',
      }))
      if (commands.length > 0) {
        session.commands = commands
      }
      return commands
    } catch {
      // No supportedCommands support (older CLI) — no `/` menu, no error.
      return []
    }
  }

  /**
   * Start a brand-new session rooted at `cwd`. The id is minted up front and
   * passed to the SDK (like `claude --session-id`), so rows/pins/terminals key
   * on it exactly as today and we never have to wait on the init message.
   */
  async create(cwd: string): Promise<string> {
    const { query } = await loadSdk(this.sdkEntry)
    const id = randomUUID()
    const session: ChatSession = {
      id,
      cwd,
      status: 'idle',
      messages: [],
      toolCards: new Map(),
      queue: new PushQueue<SdkUserMessage>(),
      pending: new Map(),
      permissionMode: 'default',
      branch: gitBranch(cwd),
    }
    this.sessions.set(id, session)
    session.query = query({
      prompt: session.queue,
      options: { ...this.optionsFor(session), sessionId: id },
    })
    void this.consume(session)
    return id
  }

  /** Resume an existing (idle) session by id, seeding the log with its history. */
  async resume(id: string, cwd: string): Promise<string> {
    const existing = this.sessions.get(id)
    if (existing) {
      return existing.id
    }
    const { query } = await loadSdk(this.sdkEntry)
    const file = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd), `${id}.jsonl`)
    const session: ChatSession = {
      id,
      cwd,
      status: 'idle',
      messages: parseTranscriptMessages(file),
      toolCards: new Map(),
      queue: new PushQueue<SdkUserMessage>(),
      pending: new Map(),
      permissionMode: 'default',
      branch: gitBranch(cwd),
      // Live model isn't reported until the first turn — seed from history so the
      // footer shows it right away on resume.
      model: lastAssistantModel(file),
    }
    // Index history tool cards so later live tool_results can attach to them.
    for (const message of session.messages) {
      for (const block of message.blocks) {
        if (block.type === 'tool_use') {
          session.toolCards.set(block.id, block)
        }
      }
    }
    this.sessions.set(id, session)
    session.query = query({
      prompt: session.queue,
      options: { ...this.optionsFor(session), resume: id },
    })
    void this.consume(session)
    return id
  }

  /**
   * Send a user turn. Appends the prompt to the log optimistically. Any attached
   * images ride along as base64 content blocks; the `[Image #N]` tokens the
   * composer inserted are plain text in `text`, so the optimistic message renders
   * them inline for free (no separate image block needed).
   */
  send(id: string, text: string, images?: ChatImageAttachment[]): void {
    const session = this.sessions.get(id)
    if (!session || (!text.trim() && !images?.length)) {
      return
    }
    const message: ChatMessage = { id: randomUUID(), role: 'user', blocks: [{ type: 'text', text }] }
    session.messages.push(message)
    this.emit({ type: 'append', sessionId: id, message })
    this.setStatus(session, 'streaming')

    // Plain string when there are no images (unchanged behavior); otherwise an
    // Anthropic content-block array: the text first (when present), then one
    // base64 image block per attachment.
    let content: string | SdkContentBlock[] = text
    if (images?.length) {
      const blocks: SdkContentBlock[] = []
      if (text.trim()) {
        blocks.push({ type: 'text', text })
      }
      for (const img of images) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
      }
      content = blocks
    }
    session.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SdkUserMessage)
  }

  /**
   * Run a raw shell command from the composer `!` prefix. Executes in the
   * session's login shell and cwd; the command echo + output render in the chat
   * as a `Bash` tool card, but are NOT sent to Claude (the SDK query is untouched).
   */
  runCommand(id: string, command: string): void {
    const session = this.sessions.get(id)
    const cmd = command.trim()
    if (!session || !cmd) {
      return
    }

    // Echo the command as a user message, as if the composer typed it.
    const echo: ChatMessage = { id: randomUUID(), role: 'user', blocks: [{ type: 'text', text: `!${cmd}` }] }
    session.messages.push(echo)
    this.emit({ type: 'append', sessionId: id, message: echo })

    // A pending tool card we resolve once the command exits.
    const card: ChatToolUseBlock = {
      type: 'tool_use',
      id: randomUUID(),
      name: 'Bash',
      label: cmd,
      input: { command: cmd },
      status: 'pending',
    }
    const message: ChatMessage = { id: randomUUID(), role: 'assistant', blocks: [card] }
    session.messages.push(message)
    session.toolCards.set(card.id, card)
    this.emit({ type: 'append', sessionId: id, message })
    // Show the composer's "Working…" state (and turn Send into Stop) while it runs.
    this.setStatus(session, 'streaming')

    // Login (`-l`) but NOT interactive: `-l` sources `.zprofile`/`.zshenv` so PATH is
    // set, while skipping `.zshrc` — that avoids interactive-only rc noise (p10k /
    // gitstatus init, `setopt monitor`) that has no TTY here. Trade-off: PATH tweaks
    // that live only in `.zshrc` won't apply to `!` commands, by design (matches the
    // SDK's own non-interactive Bash tool).
    const shell = process.env.SHELL || 'zsh'
    const child = spawn(shell, ['-lc', cmd], { cwd: session.cwd })

    let output = ''
    const MAX_CAPTURE = 100_000 // cap captured bytes to bound memory
    const capture = (buf: Buffer): void => {
      if (output.length < MAX_CAPTURE) {
        output += buf.toString()
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    let settled = false
    let timedOut = false
    const finish = (status: 'done' | 'error', note?: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      const clean = stripAnsi(output)
      const body = note ? (clean ? `${clean}\n${note}` : note) : clean
      card.result = (body.trim() || '(no output)').slice(0, 4000)
      card.status = status
      this.setStatus(session, status === 'error' ? 'error' : 'idle')
      this.emit({ type: 'update', sessionId: id, message: this.messageOfCard(session, card) })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 30_000)

    child.on('error', (err) => finish('error', `Failed to run command: ${err.message}`))
    child.on('close', (code) => {
      if (timedOut) {
        finish('error', 'Command timed out after 30s and was killed.')
      } else {
        finish(code === 0 ? 'done' : 'error', code === 0 ? undefined : `Exited with code ${code ?? 'unknown'}`)
      }
    })
  }

  /** Resolve a parked tool-permission prompt with the user's choice. */
  respondPermission(requestId: string, allow: boolean): void {
    for (const session of this.sessions.values()) {
      const pending = session.pending.get(requestId)
      if (!pending) {
        continue
      }
      session.pending.delete(requestId)
      const card = session.toolCards.get(requestId)
      if (card) {
        card.status = allow ? 'allowed' : 'denied'
        this.emit({ type: 'update', sessionId: session.id, message: this.messageOfCard(session, card) })
      }
      this.emit({ type: 'permissionResolved', sessionId: session.id, requestId })
      pending.resolve(
        allow
          ? { behavior: 'allow', updatedInput: card ? (card.input as Record<string, unknown>) : {} }
          : { behavior: 'deny', message: 'Denied by the user.' },
      )
      this.setStatus(session, 'streaming')
      return
    }
  }

  interrupt(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.query) {
      return
    }
    void session.query.interrupt().catch(() => undefined)
    this.setStatus(session, 'idle')
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    session.queue.end()
    session.query?.close()
    this.sessions.delete(id)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id)
    }
  }

  // --- internals -----------------------------------------------------------

  private optionsFor(session: ChatSession): SdkOptions {
    return {
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      // Surface every tool prompt to the chat UI as Approve/Deny.
      canUseTool: (toolName, input, opts) => this.onPermission(session, toolName, input, opts),
      // Drive the user's installed Claude CLI. We don't ship the SDK's own ~240MB
      // bundled binary, so this must resolve to a real executable. Throws (→ a
      // clear "Could not start chat session" error) if none is found.
      pathToClaudeCodeExecutable: this.resolveClaudePath(),
    } as SdkOptions
  }

  /**
   * Absolute path to the `claude` executable the Agent SDK should spawn.
   * Resolution order: the `heroCode.claudePath` setting, then common install
   * locations, then a login-shell PATH lookup (the extension host's own PATH
   * often omits `~/.local/bin` when VS Code is launched from the GUI). Memoized;
   * throws a user-facing error if nothing resolves.
   */
  private resolveClaudePath(): string {
    if (this.claudePathCache) {
      return this.claudePathCache
    }
    const found = findClaudeExecutable()
    if (!found) {
      throw new Error(
        'Could not locate the `claude` executable. Set `heroCode.claudePath` to its absolute path.',
      )
    }
    this.claudePathCache = found
    return found
  }

  /** Drive one session's message stream into the chat log + panel events. */
  private async consume(session: ChatSession): Promise<void> {
    try {
      for await (const msg of session.query as SdkQuery) {
        this.handle(session, msg)
      }
    } catch (err) {
      this.appendError(session, err instanceof Error ? err.message : String(err))
    }
  }

  private handle(session: ChatSession, msg: SdkMessage): void {
    switch (msg.type) {
      case 'system': {
        // init/status messages carry the live model + permission mode.
        let changed = false
        if (msg.model && msg.model !== session.model) {
          session.model = msg.model
          changed = true
        }
        if (msg.permissionMode && msg.permissionMode !== session.permissionMode) {
          session.permissionMode = msg.permissionMode
          changed = true
        }
        if (changed) {
          this.emitMeta(session)
        }
        if (msg.subtype === 'init') {
          void this.refreshContext(session)
        }
        return
      }
      case 'assistant': {
        if (msg.message?.model && msg.message.model !== session.model) {
          session.model = msg.message.model
          this.emitMeta(session)
        }
        const message = this.renderAssistant(session, msg)
        if (message.blocks.length) {
          session.messages.push(message)
          this.emit({ type: 'append', sessionId: session.id, message })
        }
        this.setStatus(session, 'streaming')
        return
      }
      case 'user': {
        // Live tool_results arrive as replayed user messages; attach them to the
        // matching card. Our own typed prompt is already shown optimistically.
        this.attachToolResults(session, msg)
        return
      }
      case 'result': {
        this.setStatus(session, msg.subtype === 'success' ? 'idle' : 'error')
        // A turn just ended → context grew; refresh the footer's usage bar.
        void this.refreshContext(session)
        return
      }
      default:
        return
    }
  }

  /** Assemble the composer footer's live facts. */
  private metaOf(session: ChatSession): ChatMeta {
    return {
      model: session.model,
      permissionMode: session.permissionMode,
      branch: session.branch,
      contextPercent: session.contextPercent,
    }
  }

  private emitMeta(session: ChatSession): void {
    this.emit({ type: 'meta', sessionId: session.id, meta: this.metaOf(session) })
  }

  /**
   * Ask the live session for its exact context usage (the same figure Claude
   * Code's own context bar shows) and update the footer if it moved. Guarded so
   * an older/slow CLI without the control request never breaks the composer.
   */
  private async refreshContext(session: ChatSession): Promise<void> {
    const query = session.query
    if (!query) {
      return
    }
    try {
      const usage = await query.getContextUsage()
      let changed = false
      if (typeof usage.percentage === 'number') {
        // SDK reports 0–100; tolerate a 0–1 fraction defensively.
        const pct = usage.percentage <= 1 ? usage.percentage * 100 : usage.percentage
        const rounded = Math.max(0, Math.min(100, Math.round(pct)))
        if (rounded !== session.contextPercent) {
          session.contextPercent = rounded
          changed = true
        }
      }
      if (usage.model && usage.model !== session.model) {
        session.model = usage.model
        changed = true
      }
      if (changed) {
        this.emitMeta(session)
      }
    } catch {
      // No getContextUsage support (older CLI) — leave the footer as-is.
    }
  }

  /**
   * Cycle the live session's permission mode (Shift+Tab in the composer). Emits
   * the new mode optimistically; the CLI echoes it back via a system/status
   * message, which reconciles if the change was rejected.
   */
  cycleMode(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.query) {
      return
    }
    const order = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
    const next = order[(order.indexOf(session.permissionMode) + 1) % order.length]
    session.permissionMode = next
    this.emitMeta(session)
    void session.query.setPermissionMode(next).catch(() => undefined)
  }

  private renderAssistant(session: ChatSession, msg: { uuid?: string; message?: { content?: unknown } }): ChatMessage {
    const id = msg.uuid ?? randomUUID()
    const blocks: ChatMessage['blocks'] = []
    const content = (msg.message?.content ?? []) as Array<Record<string, unknown>>
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const card: ChatToolUseBlock = {
          type: 'tool_use',
          id: block.id,
          name,
          label: describeTool(name, block.input as ToolInput | undefined),
          input: block.input,
          status: 'pending',
        }
        session.toolCards.set(card.id, card)
        blocks.push(card)
      }
    }
    return { id, role: 'assistant', blocks }
  }

  private attachToolResults(session: ChatSession, msg: { message?: { content?: unknown } }): void {
    const content = msg.message?.content
    if (!Array.isArray(content)) {
      return
    }
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        continue
      }
      const card = session.toolCards.get(block.tool_use_id)
      if (!card) {
        continue
      }
      card.result = flattenResult(block.content).slice(0, 4000)
      // Preserve an explicit deny; otherwise reflect success/error.
      if (card.status !== 'denied') {
        card.status = block.is_error ? 'error' : 'done'
      }
      this.emit({ type: 'update', sessionId: session.id, message: this.messageOfCard(session, card) })
    }
  }

  private onPermission(
    session: ChatSession,
    toolName: string,
    input: Record<string, unknown>,
    opts: SdkPermissionInfo,
  ): Promise<SdkPermissionResult> {
    const requestId = opts.toolUseID || opts.requestId || randomUUID()
    const request: PermissionRequest = {
      requestId,
      sessionId: session.id,
      toolName,
      title: opts.title,
      displayName: opts.displayName,
      input,
    }
    this.setStatus(session, 'awaiting-permission')
    this.emit({ type: 'permission', request })
    return new Promise<SdkPermissionResult>((resolve) => {
      session.pending.set(requestId, { request, resolve })
    })
  }

  /** Wrap an updated card as an `update` message the webview can splice in by id. */
  private messageOfCard(session: ChatSession, card: ChatToolUseBlock): ChatMessage {
    const owner = session.messages.find((m) => m.blocks.includes(card))
    return owner ?? { id: card.id, role: 'assistant', blocks: [card] }
  }

  private appendError(session: ChatSession, text: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      blocks: [{ type: 'text', text: `⚠️ ${text}` }],
    }
    session.messages.push(message)
    this.emit({ type: 'append', sessionId: session.id, message })
    this.setStatus(session, 'error')
  }

  private setStatus(session: ChatSession, status: ChatStatus): void {
    if (session.status === status) {
      return
    }
    session.status = status
    this.emit({ type: 'status', sessionId: session.id, status })
  }

  private titleOf(session: ChatSession): string {
    const firstUser = session.messages.find((m) => m.role === 'user')
    const text = firstUser?.blocks.find((b) => b.type === 'text') as { text: string } | undefined
    return text ? text.text.split('\n')[0].slice(0, 80) : 'New chat'
  }
}

/**
 * Current git branch of `cwd`. Reads `.git/HEAD` directly (cheap, no subprocess)
 * and falls back to `git rev-parse` for subfolders/worktrees. Detached HEAD or a
 * non-repo yields `HEAD` / `undefined` respectively.
 */
function gitBranch(cwd: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (ref) {
      return ref[1]
    }
  } catch {
    // .git/HEAD not directly here (subfolder, worktree, or not a repo).
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString().trim() || undefined
  } catch {
    return undefined
  }
}

// Match CSI/OSC ANSI escape sequences so shell output (colored `git status`,
// error text, etc.) renders as clean text in the Bash card instead of raw `[31m…`.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/** Flatten a tool_result `content` (string or `{type:'text',text}[]`) to text. */
function flattenResult(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('')
  }
  return ''
}
