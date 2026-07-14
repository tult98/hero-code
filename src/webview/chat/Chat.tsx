import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatMeta, ChatOutbound, ChatStatus, PermissionRequest } from '../../chat/types.js'
import { vscode } from './vscode-api.js'
import { Message } from './Message.js'

/**
 * Per-status header pill: label, a full literal Tailwind color token (so the
 * scanner picks it up), and the codicon that precedes it. `streaming` reuses the
 * spinning-loading convention from `ToolCard`.
 */
const STATUS_META: Record<ChatStatus, { label: string; color: string; icon: string }> = {
  idle: { label: 'Ready', color: 'text-vs-desc', icon: 'codicon-circle-outline' },
  streaming: { label: 'Working', color: 'text-vs-accent', icon: 'codicon-loading codicon-modifier-spin' },
  'awaiting-permission': { label: 'Waiting', color: 'text-vs-yellow', icon: 'codicon-circle-filled' },
  error: { label: 'Error', color: 'text-vs-red', icon: 'codicon-error' },
}

/** Empty-state prompt suggestions; clicking one prefills the composer. */
const SUGGESTIONS = [
  { icon: 'comment-discussion', text: 'Explain the selected file' },
  { icon: 'bug', text: 'Fix the failing test' },
  { icon: 'git-commit', text: 'Write a commit message' },
]

/** Friendly permission-mode labels for the footer. */
const MODE_LABEL: Record<string, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  auto: 'auto',
  bypassPermissions: 'bypass',
}

/** `claude-opus-4-8` → `Opus 4.8`; falls back to the raw id, then a dash. */
function modelLabel(raw?: string): string {
  if (!raw) {
    return '—'
  }
  const m = raw.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i)
  if (m) {
    const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    const version = m[3] ? `${m[2]}.${m[3]}` : m[2]
    return `${family} ${version}`
  }
  return raw
}

export function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('Claude Chat')
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [meta, setMeta] = useState<ChatMeta>({})
  const [input, setInput] = useState('')
  const [showThinking, setShowThinking] = useState(true)
  const [scrolledUp, setScrolledUp] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent<ChatOutbound>) => {
      const msg = event.data
      switch (msg.type) {
        case 'hydrate':
          setSessionId(msg.sessionId)
          setTitle(msg.title || 'Claude Chat')
          setStatus(msg.status)
          setMessages(msg.messages)
          setPermission(msg.permission ?? null)
          setMeta(msg.meta ?? {})
          break
        case 'meta':
          setMeta(msg.meta)
          break
        case 'append':
          setMessages((prev) => [...prev, msg.message])
          break
        case 'update':
          setMessages((prev) => prev.map((m) => (m.id === msg.message.id ? msg.message : m)))
          break
        case 'status':
          setStatus(msg.status)
          break
        case 'permission':
          setPermission(msg.request)
          break
        case 'permissionResolved':
          setPermission((prev) => (prev?.requestId === msg.requestId ? null : prev))
          break
        case 'mention':
          setInput((prev) => (prev ? `${prev}${msg.text}` : msg.text))
          break
      }
    }
    window.addEventListener('message', onMessage)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Keep the newest message / prompt in view as the conversation grows, unless
  // the user has scrolled up to read earlier output.
  useEffect(() => {
    if (scrolledUp) {
      return
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, permission, status, scrolledUp])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
  }

  const jumpDown = () => {
    const el = scrollRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight })
    }
    setScrolledUp(false)
  }

  const send = () => {
    const text = input.trim()
    if (!text || !sessionId) {
      return
    }
    vscode.postMessage({ type: 'send', sessionId, text })
    setInput('')
  }

  const respond = (allow: boolean) => {
    if (!permission) {
      return
    }
    vscode.postMessage({ type: 'permissionResponse', sessionId: permission.sessionId, requestId: permission.requestId, allow })
    setPermission(null)
  }

  const interrupt = () => {
    if (sessionId) {
      vscode.postMessage({ type: 'interrupt', sessionId })
    }
  }

  const busy = status === 'streaming' || status === 'awaiting-permission'
  const statusMeta = STATUS_META[status]

  if (!sessionId) {
    return (
      <div className='flex h-full items-center justify-center px-6 text-center text-vs-desc'>
        Select a session in the sidebar to open it here.
      </div>
    )
  }

  return (
    <div className='flex flex-col h-full min-h-0'>
      {/* HEADER */}
      <div className='h-9 shrink-0 flex items-center gap-2 px-3 border-b border-(--vscode-panel-border,transparent)'>
        <span className='codicon codicon-claude text-base text-vs-accent shrink-0' />
        <span className='flex-1 min-w-0 text-sm font-semibold truncate text-vs-fg'>{title}</span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border border-(--vscode-panel-border,transparent) px-2 py-0.5 text-[10.5px] font-semibold ${statusMeta.color}`}>
          <span className={`codicon ${statusMeta.icon} text-[10px]`} />
          {statusMeta.label}
        </span>
        <span
          role='button'
          title='Show / hide thinking'
          onClick={() => setShowThinking((v) => !v)}
          className={`codicon ${showThinking ? 'codicon-eye' : 'codicon-eye-closed'} text-sm text-vs-desc cursor-pointer rounded p-0.5 hover:text-vs-fg hover:bg-vs-hover-bg`}
        />
      </div>

      {/* TRANSCRIPT */}
      <div className='relative flex-1 min-h-0'>
        <div ref={scrollRef} onScroll={onScroll} className='h-full overflow-y-auto px-4 py-3'>
          {messages.length === 0 ? (
            <div className='flex h-full flex-col items-center justify-center gap-3 px-7 text-center'>
              <span className='codicon codicon-claude text-[36px] text-vs-accent' />
              <div className='text-[15px] font-semibold text-vs-fg'>Send a message to start</div>
              <div className='max-w-[250px] text-xs leading-relaxed text-vs-desc'>
                Ask Claude to build, fix, or explain anything in this workspace.
              </div>
              <div className='mt-1 flex w-full max-w-[270px] flex-col gap-1.5'>
                {SUGGESTIONS.map((s) => (
                  <div
                    key={s.text}
                    role='button'
                    onClick={() => setInput(s.text)}
                    className='flex items-center gap-2 rounded-lg border border-(--vscode-panel-border,transparent) bg-vs-hover-bg/40 px-3 py-2 text-xs text-vs-fg cursor-pointer hover:border-vs-accent'
                  >
                    <span className={`codicon codicon-${s.icon} text-vs-desc`} />
                    {s.text}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <Message key={m.id} message={m} />
              ))}
              {status === 'streaming' && (
                <div className='flex items-center gap-2 text-xs text-vs-accent animate-scpulse'>
                  <span className='codicon codicon-sparkle' />
                  Working…
                </div>
              )}
            </>
          )}
        </div>
        {scrolledUp && (
          <button
            onClick={jumpDown}
            className='absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-(--vscode-panel-border,transparent) bg-(--vscode-editorWidget-background) px-3 py-1 text-[11px] font-semibold text-vs-fg shadow-lg hover:opacity-90'
          >
            <span className='codicon codicon-arrow-down' />
            Jump to latest
          </button>
        )}
      </div>

      {/* COMPOSER */}
      <div className='shrink-0 border-t border-(--vscode-panel-border,transparent) px-2.5 py-2'>
        {permission && (
          <div className='mb-2 rounded border border-(--vscode-inputValidation-warningBorder,transparent) bg-(--vscode-inputValidation-warningBackground) px-3 py-2 text-xs text-vs-fg'>
            <div className='mb-1.5'>{permission.title ?? `Allow ${permission.displayName ?? permission.toolName}?`}</div>
            <div className='flex gap-2'>
              <button className='rounded px-2 py-0.5 bg-vs-accent text-black hover:opacity-90' onClick={() => respond(true)}>
                Approve
              </button>
              <button className='rounded px-2 py-0.5 bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90' onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          </div>
        )}

        {/* Input card */}
        <div className='flex flex-col gap-2 rounded-xl border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2.5 py-2 focus-within:border-vs-accent'>
          <textarea
            className='w-full resize-none bg-transparent outline-none text-sm leading-snug text-(--vscode-input-foreground) placeholder:text-vs-desc'
            rows={2}
            placeholder={messages.length === 0 ? 'Send a message to start…' : 'Reply to Claude…   @ files   / commands'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              } else if (e.key === 'Tab' && e.shiftKey) {
                // Cycle the live session's permission mode, like Claude Code.
                e.preventDefault()
                if (sessionId) {
                  vscode.postMessage({ type: 'cycleMode', sessionId })
                }
              }
            }}
          />
          <div className='flex items-center gap-0.5'>
            <span className='codicon codicon-add text-base text-vs-desc cursor-pointer rounded p-1 hover:text-vs-fg hover:bg-vs-hover-bg' title='Attach image or file' />
            <span className='codicon codicon-mention text-base text-vs-desc cursor-pointer rounded p-1 hover:text-vs-fg hover:bg-vs-hover-bg' title='Mention a file' />
            <span className='codicon codicon-symbol-operator text-base text-vs-desc cursor-pointer rounded p-1 hover:text-vs-fg hover:bg-vs-hover-bg' title='Slash command' />
            <span className='flex-1' />
            {busy ? (
              <button className='inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90' title='Interrupt' onClick={interrupt}>
                <span className='codicon codicon-debug-stop' />
                Stop
              </button>
            ) : (
              <button className='inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold bg-vs-accent text-black hover:opacity-90 disabled:opacity-50' title='Send' disabled={!input.trim()} onClick={send}>
                <span className='codicon codicon-send' />
                Send
              </button>
            )}
          </div>
        </div>

        {/* Meta footer — live per-session facts from the session's SDK stream. */}
        <div className='flex items-center gap-3 mt-1.5 px-0.5 text-[10.5px] text-vs-desc flex-wrap'>
          <span className='flex items-center gap-1' title='Model'><span className='codicon codicon-chip text-[11px]' />{modelLabel(meta.model)}</span>
          <span className='flex items-center gap-1' title='Permission mode · Shift+Tab to cycle'><span className='codicon codicon-shield text-[11px]' />{MODE_LABEL[meta.permissionMode ?? ''] ?? meta.permissionMode ?? '—'}</span>
          <span className='flex items-center gap-1' title='Git branch'><span className='codicon codicon-git-branch text-[11px]' />{meta.branch ?? '—'}</span>
          <span className='flex-1' />
          {meta.contextPercent != null && (
            <span className='flex items-center gap-1.5' title='Context window used'>
              <span className='relative inline-block w-8 h-1 rounded overflow-hidden bg-(--vscode-scrollbarSlider-background)'>
                <span className='absolute inset-y-0 left-0 rounded bg-vs-green' style={{ width: `${Math.round(meta.contextPercent)}%` }} />
              </span>
              {Math.round(meta.contextPercent)}%
            </span>
          )}
        </div>

        {/* Keyboard hints */}
        <div className='flex items-center gap-1.5 mt-1 px-0.5 text-[10.5px] text-vs-desc'>
          <span>Shift+Tab to cycle</span>
          <span className='opacity-60'>·</span>
          <span>Shift+Enter for newline</span>
        </div>
      </div>
    </div>
  )
}
