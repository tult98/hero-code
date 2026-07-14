import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { ChatMessage, ChatOutbound, ChatStatus, ChatToolUseBlock, PermissionRequest } from './types.js'
import { describeTool, encodeProjectPath, parseTranscriptMessages } from '../transcript.js'
import type { ToolInput } from '../types.js'

// Minimal local shapes for the Agent SDK. We deliberately avoid importing the
// SDK's own types: it's an ESM-only package and type-importing it from this CJS
// host requires import attributes the host tsconfig doesn't enable. We only use
// a small, stable surface, so local shapes are simpler and sufficient.
type SdkUserMessage = { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null }
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
}
type SdkMessage = { type: string; subtype?: string; session_id?: string; uuid?: string; message?: { content?: unknown } }
interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>
  close(): void
}
type SdkModule = { query: (params: { prompt: string | AsyncIterable<SdkUserMessage>; options?: SdkOptions }) => SdkQuery }

let sdkPromise: Promise<SdkModule> | undefined

/**
 * Load the Claude Agent SDK. It is ESM-only and resolves its own bundled CLI via
 * `import.meta.url`, so it must be imported at runtime from `node_modules` rather
 * than bundled into our CJS host. The `new Function` wrapper hides the specifier
 * from esbuild so the real dynamic `import()` survives the CJS transform (esbuild
 * would otherwise rewrite it to `require()`, which fails on an ESM package).
 */
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<SdkModule>
    sdkPromise = dynamicImport('@anthropic-ai/claude-agent-sdk')
  }
  return sdkPromise
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
}

/**
 * Owns SDK-driven chat sessions: one long-lived `query()` per session (streaming
 * input mode, so a session takes many turns), the accumulated chat log, and
 * parked tool-permission prompts. Emits {@link ChatOutbound} events; the panel
 * decides which to forward to the webview (only the active session's).
 */
export class ChatSessionManager {
  private sessions = new Map<string, ChatSession>()

  constructor(private readonly emit: (event: ChatOutbound) => void) {}

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /** Snapshot for hydrating the panel when a session becomes active. */
  snapshot(id: string): { title: string; messages: ChatMessage[]; status: ChatStatus; permission?: PermissionRequest } | undefined {
    const session = this.sessions.get(id)
    if (!session) {
      return undefined
    }
    const permission = [...session.pending.values()][0]?.request
    return { title: this.titleOf(session), messages: session.messages, status: session.status, permission }
  }

  /**
   * Start a brand-new session rooted at `cwd`. The id is minted up front and
   * passed to the SDK (like `claude --session-id`), so rows/pins/terminals key
   * on it exactly as today and we never have to wait on the init message.
   */
  async create(cwd: string): Promise<string> {
    const { query } = await loadSdk()
    const id = randomUUID()
    const session: ChatSession = {
      id,
      cwd,
      status: 'idle',
      messages: [],
      toolCards: new Map(),
      queue: new PushQueue<SdkUserMessage>(),
      pending: new Map(),
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
    const { query } = await loadSdk()
    const file = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd), `${id}.jsonl`)
    const session: ChatSession = {
      id,
      cwd,
      status: 'idle',
      messages: parseTranscriptMessages(file),
      toolCards: new Map(),
      queue: new PushQueue<SdkUserMessage>(),
      pending: new Map(),
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

  /** Send a user turn. Appends the prompt to the log optimistically. */
  send(id: string, text: string): void {
    const session = this.sessions.get(id)
    if (!session || !text.trim()) {
      return
    }
    const message: ChatMessage = { id: randomUUID(), role: 'user', blocks: [{ type: 'text', text }] }
    session.messages.push(message)
    this.emit({ type: 'append', sessionId: id, message })
    this.setStatus(session, 'streaming')
    session.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SdkUserMessage)
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
      permissionMode: 'default',
      // Surface every tool prompt to the chat UI as Approve/Deny.
      canUseTool: (toolName, input, opts) => this.onPermission(session, toolName, input, opts),
    } as SdkOptions
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
      case 'system':
        // Session id is assigned up front (create) or known (resume); the init
        // message needs no handling.
        return
      case 'assistant': {
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
        return
      }
      default:
        return
    }
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
