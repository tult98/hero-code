import { useEffect, useRef, useState } from 'react'
import type { ChatImageAttachment, ChatMessage, ChatMeta, ChatOutbound, ChatStatus, PermissionRequest } from '../../chat/types.js'
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

/**
 * Per-mode styling for the footer's click-to-cycle permission-mode pill: friendly
 * label, codicon, and the pill's text / background / border colors. Keyed by the
 * SDK's `permissionMode`; `default` is shown as "manual".
 */
type ModeStyle = { label: string; icon: string; color: string; bg: string; border: string }
const MODE_STYLE: Record<string, ModeStyle> = {
  default: { label: 'manual', icon: 'codicon-debug-pause', color: '#b9b9b9', bg: '#ffffff10', border: '#4a4a4a' },
  acceptEdits: { label: 'accept edits', icon: 'codicon-debug-continue', color: '#b18cf0', bg: '#b18cf01f', border: '#4c3d6b' },
  plan: { label: 'plan', icon: 'codicon-debug-pause', color: '#5fd39a', bg: '#5fd39a1f', border: '#356048' },
  auto: { label: 'auto', icon: 'codicon-debug-continue', color: '#e6a34a', bg: '#e6a34a1f', border: '#6a5228' },
  bypassPermissions: { label: 'bypass permissions', icon: 'codicon-debug-continue', color: '#f0776a', bg: '#f0776a1f', border: '#6a3a34' },
}

/** Rotating hints shown in the composer's tip line (cycled while mounted). */
const TIPS = [
  'Tip: type @ to reference a file',
  'Tip: / runs a slash command',
  'Tip: Shift+Tab cycles the mode',
  'Tip: paste or drag an image to attach it',
  'Tip: Esc interrupts a running turn',
]

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

/**
 * Context-window size label for the footer's usage readout. The SDK only reports a
 * percentage, so the denominator is inferred from the model id: 1M-context models
 * (id marked `1m`) show `1M`, everything else `200K`.
 */
function contextTotalLabel(model?: string): string {
  return /1m/i.test(model ?? '') ? '1M' : '200K'
}

export function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('Claude Chat')
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [meta, setMeta] = useState<ChatMeta>({})
  const [input, setInput] = useState('')
  // Pasted/dropped images, sent as base64 blocks on the next turn. Each is
  // referenced by an `[Image #N]` token the caller inserted into the composer.
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [showThinking, setShowThinking] = useState(true)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [tipIdx, setTipIdx] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Cycle the composer's hint line while mounted.
  useEffect(() => {
    const id = setInterval(() => setTipIdx((i) => (i + 1) % TIPS.length), 12000)
    return () => clearInterval(id)
  }, [])

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
          // Move focus into the composer so the user can keep typing after
          // referencing code (Opt+Cmd+K), caret at the end of the input.
          requestAnimationFrame(() => {
            const ta = textareaRef.current
            if (ta) {
              ta.focus()
              ta.setSelectionRange(ta.value.length, ta.value.length)
            }
          })
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

  // Read an image File as a base64 attachment (strips the `data:<mime>;base64,` prefix).
  const readAsAttachment = (file: File) =>
    new Promise<ChatImageAttachment>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => {
        const url = String(reader.result) // data:image/png;base64,XXXX
        resolve({ mediaType: file.type || 'image/png', data: url.slice(url.indexOf(',') + 1) })
      }
      reader.readAsDataURL(file)
    })

  // Insert text at the composer's caret (replacing any selection), then restore
  // focus with the caret just after the inserted snippet.
  const insertAtCaret = (snippet: string) => {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? input.length
    const end = ta?.selectionEnd ?? input.length
    setInput((prev) => prev.slice(0, start) + snippet + prev.slice(end))
    requestAnimationFrame(() => {
      if (ta) {
        const pos = start + snippet.length
        ta.focus()
        ta.setSelectionRange(pos, pos)
      }
    })
  }

  // Attach image files: drop an `[Image #N]` token at the caret for each (Claude
  // Code style), then load their bytes. Returns whether any images were taken.
  const ingestImages = (files: File[]): boolean => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      return false
    }
    const base = images.length
    insertAtCaret(imageFiles.map((_, i) => `[Image #${base + i + 1}]`).join(' ') + ' ')
    void Promise.all(imageFiles.map(readAsAttachment)).then((loaded) => setImages((prev) => [...prev, ...loaded]))
    return true
  }

  const send = () => {
    const text = input.trim()
    if (!sessionId || (!text && images.length === 0)) {
      return
    }
    vscode.postMessage({ type: 'send', sessionId, text, images: images.length ? images : undefined })
    setInput('')
    setImages([])
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
        <div className='flex flex-col gap-[7px] rounded-[11px] border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2.5 py-2 focus-within:border-vs-accent'>
          <textarea
            ref={textareaRef}
            className='w-full resize-none bg-transparent outline-none text-sm leading-[1.45] min-h-[38px] text-(--vscode-input-foreground) placeholder:text-vs-desc'
            rows={2}
            placeholder={messages.length === 0 ? 'Send a message to start…' : 'Reply to Claude…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file')
                .map((it) => it.getAsFile())
                .filter((f): f is File => f != null)
              if (files.some((f) => f.type.startsWith('image/')) && ingestImages(files)) {
                e.preventDefault()
              }
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) {
                e.preventDefault()
              }
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? [])
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault()
                ingestImages(files)
              }
            }}
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
              } else if (e.key === 'Escape' && busy) {
                // Esc interrupts a running turn.
                e.preventDefault()
                interrupt()
              }
            }}
          />
          <div className='flex items-center gap-2'>
            {/* Rotating hint — replaces the old (non-functional) attach/mention/slash icons. */}
            <span className='flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden text-[10.5px] text-vs-desc'>
              <span className='codicon codicon-lightbulb shrink-0' style={{ fontSize: '12px' }} />
              <span className='truncate'>{TIPS[tipIdx]}</span>
            </span>
            {busy ? (
              <button className='inline-flex items-center gap-1.5 rounded-lg border border-[#6a3a3a] px-3.5 py-1.5 text-xs font-bold text-[#f0a8a2] hover:bg-[#2a1a1a] hover:border-[#f14c4c]' title='Interrupt' onClick={interrupt}>
                <span className='codicon codicon-debug-stop' style={{ fontSize: '13px' }} />
                Stop
              </button>
            ) : (
              <button className='inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold bg-vs-accent text-[#1a1a1a] hover:bg-[#e08862] disabled:opacity-50' title='Send' disabled={!input.trim() && images.length === 0} onClick={send}>
                <span className='codicon codicon-send' style={{ fontSize: '13px' }} />
                Send
              </button>
            )}
          </div>
        </div>

        {/* Meta footer — live per-session facts from the session's SDK stream. */}
        <div className='flex items-center gap-2.5 mt-1.5 px-0.5 text-[10.5px] text-vs-desc flex-wrap'>
          <span className='flex items-center gap-1.5 text-[#c4b3e0]' title='Model'>
            <span className='codicon codicon-sparkle text-[#a78bcf]' style={{ fontSize: '12px' }} />
            {modelLabel(meta.model)}
          </span>
          {(() => {
            const mode = MODE_STYLE[meta.permissionMode ?? ''] ?? MODE_STYLE.default
            return (
              <span
                className='flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-bold cursor-pointer'
                style={{ color: mode.color, background: mode.bg, borderColor: mode.border }}
                title='Permission mode · Shift+Tab to cycle'
                onClick={() => sessionId && vscode.postMessage({ type: 'cycleMode', sessionId })}
              >
                <span className={`codicon ${mode.icon}`} style={{ fontSize: '11px' }} />
                {mode.label}
              </span>
            )
          })()}
          <span className='flex-1' />
          {meta.contextPercent != null &&
            (() => {
              const pct = Math.round(meta.contextPercent)
              const color = pct >= 85 ? '#f14c4c' : pct >= 60 ? '#e2b53d' : '#89d185'
              const offset = (37.7 * (1 - pct / 100)).toFixed(1)
              return (
                <span className='flex items-center gap-1.5' title={`${pct}% of context used`}>
                  <svg width='16' height='16' viewBox='0 0 16 16' className='block' style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx='8' cy='8' r='6' fill='none' stroke='#3a3a3a' strokeWidth='2.4' />
                    <circle cx='8' cy='8' r='6' fill='none' stroke={color} strokeWidth='2.4' strokeLinecap='round' strokeDasharray='37.7' strokeDashoffset={offset} />
                  </svg>
                  <span className='font-bold' style={{ color }}>
                    {pct}%
                  </span>
                  <span>/ {contextTotalLabel(meta.model)}</span>
                </span>
              )
            })()}
        </div>

        {/* Git branch — its own row, matching the design. */}
        <div className='flex items-center gap-1 mt-1.5 px-0.5 min-w-0 text-[10.5px] text-vs-desc'>
          <span className='codicon codicon-git-branch shrink-0' style={{ fontSize: '12px' }} />
          <span className='truncate'>{meta.branch ?? '—'}</span>
        </div>
      </div>
    </div>
  )
}
