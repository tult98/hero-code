import { useEffect, useRef, useState } from 'react'
import type { ChatImageAttachment, ChatMessage, ChatMeta, ChatOutbound, ChatStatus, CommandInfo, FileHit, ModelChoice, PermissionRequest } from '../../chat/types.js'
import { vscode } from './vscode-api.js'
import { Message } from './Message.js'
import { ModelPanel, type ModelPanelStatus } from './ModelPanel.js'

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

/** Accent for the composer's `!` shell mode (pink, echoing Claude Code's bash mode). */
const SHELL_ACCENT = '#e0508f'

/** Rotating hints shown in the composer's tip line (cycled while mounted). */
const TIPS = [
  'Tip: type @ to reference a file',
  'Tip: / runs a slash command',
  'Tip: ! runs a shell command',
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

// ── Composer autocomplete (`@` files, `/` skills+commands) ──────────────────

type MenuKind = 'file' | 'command'
/** The open autocomplete: which trigger, the query after it, where the trigger starts, and the highlighted row. */
interface MenuState {
  kind: MenuKind
  query: string
  start: number
  active: number
}
/** A rendered/acceptable autocomplete row. */
interface MenuItem {
  key: string
  insert: string
  primary: string
  secondary: string
  icon: string
}

/**
 * Detect an active `@`/`/` trigger in `text` at the caret. A `/` menu opens only
 * when the slash is the first char of the composer (like Claude Code); an `@` menu
 * opens for the nearest `@` with no whitespace up to the caret, preceded by
 * start-of-input or whitespace. Returns null when no trigger is active.
 */
function detectTrigger(text: string, caret: number): { kind: MenuKind; query: string; start: number } | null {
  const before = text.slice(0, caret)
  if (before.startsWith('/')) {
    const rest = before.slice(1)
    if (!/\s/.test(rest)) {
      return { kind: 'command', query: rest, start: 0 }
    }
  }
  const at = before.lastIndexOf('@')
  if (at !== -1) {
    const between = before.slice(at + 1)
    const prev = at === 0 ? '' : before[at - 1]
    if (!/\s/.test(between) && (at === 0 || /\s/.test(prev))) {
      return { kind: 'file', query: between, start: at }
    }
  }
  return null
}

/** Filter + rank commands for the `/` menu: name-prefix beats name-substring; empty query keeps all. */
function filterCommands(cmds: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase()
  if (!q) {
    return cmds
  }
  return cmds
    .map((c) => {
      const name = c.name.toLowerCase()
      return { c, score: name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0 }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length)
    .map((x) => x.c)
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
  // Composer autocomplete: the open menu, cached `/` commands, and the latest
  // `@` file results (tagged with their query so stale responses are ignored).
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [fileHits, setFileHits] = useState<{ query: string; items: FileHit[] }>({ query: '', items: [] })
  const commandsRequested = useRef(false)
  // `/model` picker overlay: null when closed, else the latest catalog + state.
  const [modelPanel, setModelPanel] = useState<{
    status: ModelPanelStatus
    models: ModelChoice[]
    currentValue?: string
    defaultValue?: string
    error?: string
  } | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
          // A different session's commands/files no longer apply — reset the menu.
          setMenu(null)
          setCommands([])
          commandsRequested.current = false
          setFileHits({ query: '', items: [] })
          setModelPanel(null)
          break
        case 'commands':
          setCommands(msg.commands)
          commandsRequested.current = false
          break
        case 'models':
          // Ignore late catalog replies for a picker the user already closed.
          setModelPanel((prev) => (prev ? { status: msg.status, models: msg.models, currentValue: msg.currentValue, defaultValue: msg.defaultValue, error: msg.error } : prev))
          break
        case 'fileResults':
          setFileHits({ query: msg.query, items: msg.results })
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

  // Recompute the autocomplete menu from the text/caret, and (re)request its data:
  // `/` commands once per session, `@` file searches debounced. Preserves the
  // highlighted row while the trigger is unchanged so navigation isn't reset.
  const syncMenu = (text: string, caret: number) => {
    const t = detectTrigger(text, caret)
    if (!t) {
      setMenu(null)
      return
    }
    setMenu((prev) =>
      prev && prev.kind === t.kind && prev.query === t.query && prev.start === t.start
        ? prev
        : { ...t, active: 0 },
    )
    // Fetch commands lazily; retry if a prior fetch came back empty (e.g. the SDK
    // wasn't initialized yet), but never with a request already in flight.
    if (t.kind === 'command' && sessionId && commands.length === 0 && !commandsRequested.current) {
      commandsRequested.current = true
      vscode.postMessage({ type: 'listCommands', sessionId })
    }
    if (t.kind === 'file' && sessionId) {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current)
      }
      const query = t.query
      searchTimer.current = setTimeout(() => {
        vscode.postMessage({ type: 'searchFiles', sessionId, query })
      }, 120)
    }
  }

  // Accept a menu row: replace the active `@…`/`/…` token with the completion.
  const acceptMenu = (item: MenuItem) => {
    if (!menu) {
      return
    }
    const ta = textareaRef.current
    const caret = ta?.selectionStart ?? input.length
    const start = menu.start
    setInput((prev) => prev.slice(0, start) + item.insert + prev.slice(caret))
    setMenu(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        const pos = start + item.insert.length
        el.focus()
        el.setSelectionRange(pos, pos)
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

  // Open the `/model` picker over the chat view and request the catalog.
  const openModelPanel = () => {
    if (!sessionId) {
      return
    }
    setModelPanel({ status: 'loading', models: [] })
    vscode.postMessage({ type: 'listModels', sessionId })
  }

  // Close the picker and return focus to the composer.
  const closeModelPanel = () => {
    setModelPanel(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const send = () => {
    const text = input.trim()
    if (!sessionId || (!text && images.length === 0)) {
      return
    }
    // `/model` opens the native picker panel instead of sending a prompt.
    if (images.length === 0 && text === '/model') {
      setInput('')
      openModelPanel()
      return
    }
    // `!<command>` (first char, no images) runs a raw shell command instead of
    // sending a prompt to Claude — mirrors Claude Code's `!` bash mode.
    if (images.length === 0 && text.startsWith('!') && text.slice(1).trim()) {
      vscode.postMessage({ type: 'runCommand', sessionId, command: text.slice(1).trim() })
      setInput('')
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
  // `!` as the first non-space char puts the composer in shell mode: the next send
  // runs a raw command instead of prompting Claude (see `send`). Recolor the card
  // pink and swap the hint/Send affordances so this is obvious, à la Claude Code.
  const shellMode = input.trimStart().startsWith('!')

  // Derive the autocomplete rows for the open menu. File results are shown only
  // when they match the current query (otherwise the menu is still "loading").
  const menuItems: MenuItem[] = !menu
    ? []
    : menu.kind === 'command'
      ? filterCommands(commands, menu.query).map((c) => ({
          key: c.name,
          insert: `/${c.name} `,
          primary: `/${c.name}`,
          secondary: c.description || c.argumentHint,
          icon: 'codicon-terminal',
        }))
      : (fileHits.query === menu.query ? fileHits.items : []).map((h) => ({
          key: h.rel,
          insert: `@${h.rel} `,
          primary: h.name,
          secondary: h.rel,
          icon: 'codicon-file',
        }))
  const menuLoading = !!menu && menu.kind === 'file' && fileHits.query !== menu.query
  const menuActive = menu ? Math.min(menu.active, Math.max(0, menuItems.length - 1)) : 0

  if (!sessionId) {
    return (
      <div className='flex h-full items-center justify-center px-6 text-center text-vs-desc'>
        Select a session in the sidebar to open it here.
      </div>
    )
  }

  return (
    <div className='relative flex flex-col h-full min-h-0'>
      {/* `/model` picker takes over the whole chat view. */}
      {modelPanel && (
        <div className='absolute inset-0 z-30'>
          <ModelPanel
            status={modelPanel.status}
            models={modelPanel.models}
            currentValue={modelPanel.currentValue}
            defaultValue={modelPanel.defaultValue}
            currentEffort={meta?.effort}
            error={modelPanel.error}
            onCommit={(value, effort, scope) => {
              vscode.postMessage({ type: 'applyModel', sessionId, value, effort, scope })
              closeModelPanel()
            }}
            onRefresh={() => {
              setModelPanel((prev) => (prev ? { ...prev, status: 'loading' } : prev))
              vscode.postMessage({ type: 'listModels', sessionId, refresh: true })
            }}
            onClose={closeModelPanel}
          />
        </div>
      )}
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
        <div
          className='relative flex flex-col gap-[7px] rounded-[11px] border border-(--vscode-input-border,transparent) bg-(--vscode-input-background) px-2.5 py-2 focus-within:border-vs-accent'
          style={shellMode ? { borderColor: SHELL_ACCENT, background: `color-mix(in srgb, ${SHELL_ACCENT} 7%, var(--vscode-input-background))` } : undefined}
        >
          {/* Autocomplete menu (`@` files / `/` skills+commands), anchored above the card. */}
          {menu && (menuItems.length > 0 || menuLoading) && (
            <div
              className='absolute bottom-full left-0 right-0 mb-1.5 max-h-56 overflow-y-auto rounded-lg border py-1 shadow-lg z-20'
              style={{
                background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
                borderColor: 'var(--vscode-dropdown-border, var(--vscode-input-border))',
              }}
            >
              {menuLoading ? (
                <div className='px-3 py-1.5 text-[11px] text-vs-desc'>Searching…</div>
              ) : (
                menuItems.map((item, i) => (
                  <div
                    key={item.key}
                    role='button'
                    ref={(el) => {
                      if (i === menuActive) {
                        el?.scrollIntoView({ block: 'nearest' })
                      }
                    }}
                    // mousedown (not click) + preventDefault keeps textarea focus so onBlur doesn't
                    // close the menu before the pick registers.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      acceptMenu(item)
                    }}
                    onMouseEnter={() => setMenu((m) => (m ? { ...m, active: i } : m))}
                    className='flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer'
                    style={
                      i === menuActive
                        ? { background: 'var(--vscode-list-activeSelectionBackground)', color: 'var(--vscode-list-activeSelectionForeground)' }
                        : undefined
                    }
                  >
                    <span className={`codicon ${item.icon} shrink-0 text-vs-desc`} style={{ fontSize: '13px' }} />
                    <span className='shrink-0 font-medium'>{item.primary}</span>
                    {item.secondary && <span className='truncate text-vs-desc'>{item.secondary}</span>}
                  </div>
                ))
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className='w-full resize-none bg-transparent outline-none text-[13px] leading-[1.45] min-h-[38px] text-(--vscode-input-foreground) placeholder:text-vs-desc'
            rows={2}
            placeholder={messages.length === 0 ? 'Send a message to start…' : 'Reply to Claude…'}
            value={input}
            onChange={(e) => {
              let value = e.target.value
              let caret = e.target.selectionStart ?? value.length
              // Entering shell mode: a leading `!` auto-inserts a space so the command
              // types after it (`! git`), mirroring the terminal's bash mode.
              if (value.startsWith('!') && value[1] !== ' ' && !input.startsWith('!')) {
                value = `! ${value.slice(1)}`
                caret += 1
                const ta = textareaRef.current
                if (ta) {
                  requestAnimationFrame(() => ta.setSelectionRange(caret, caret))
                }
              }
              setInput(value)
              syncMenu(value, caret)
            }}
            // Recompute on caret moves (arrows/clicks) so the menu tracks the token under the caret.
            onSelect={(e) => syncMenu(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setMenu(null)}
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
              // Autocomplete navigation takes precedence over send/cycle/interrupt.
              if (menu) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMenu(null)
                  return
                }
                if (menuItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMenu((m) => (m ? { ...m, active: (menuActive + 1) % menuItems.length } : m))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMenu((m) => (m ? { ...m, active: (menuActive - 1 + menuItems.length) % menuItems.length } : m))
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    acceptMenu(menuItems[menuActive])
                    return
                  }
                }
              }
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
            {/* Shell-mode indicator, else a rotating hint (replaces the old icons). */}
            {shellMode ? (
              <span className='flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden text-[10.5px] font-bold' style={{ color: SHELL_ACCENT }}>
                <span className='codicon codicon-terminal shrink-0' style={{ fontSize: '12px' }} />
                <span className='truncate'>! for shell mode</span>
              </span>
            ) : (
              <span className='flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden text-[10.5px] text-vs-desc'>
                <span className='codicon codicon-lightbulb shrink-0' style={{ fontSize: '12px' }} />
                <span className='truncate'>{TIPS[tipIdx]}</span>
              </span>
            )}
            {busy ? (
              <button className='inline-flex items-center gap-1.5 rounded-lg border border-[#6a3a3a] px-3.5 py-1.5 text-xs font-bold text-[#f0a8a2] hover:bg-[#2a1a1a] hover:border-[#f14c4c]' title='Interrupt' onClick={interrupt}>
                <span className='codicon codicon-debug-stop' style={{ fontSize: '13px' }} />
                Stop
              </button>
            ) : shellMode ? (
              <button className='inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold text-[#1a1a1a] hover:brightness-110 disabled:opacity-50' style={{ background: SHELL_ACCENT }} title='Run shell command' disabled={!input.trim().slice(1).trim()} onClick={send}>
                <span className='codicon codicon-terminal' style={{ fontSize: '13px' }} />
                Run
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
          <span
            className='flex items-center gap-1.5 text-[#c4b3e0] cursor-pointer'
            title='Model · click to change (/model)'
            onClick={openModelPanel}
          >
            <span className='codicon codicon-sparkle text-[#a78bcf]' style={{ fontSize: '12px' }} />
            {modelLabel(meta.model)}
            {meta.effort && <span className='text-vs-desc'>· {meta.effort}</span>}
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
