import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatOutbound, ChatStatus, PermissionRequest } from '../../chat/types.js'
import { vscode } from './vscode-api.js'
import { Message } from './Message.js'

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: 'Ready',
  streaming: 'Working…',
  'awaiting-permission': 'Needs your approval',
  error: 'Error',
}

export function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('Claude Chat')
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [input, setInput] = useState('')
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

  // Keep the newest message / prompt in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, permission, status])

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

  if (!sessionId) {
    return (
      <div className='flex h-full items-center justify-center px-6 text-center text-vs-desc'>
        Select a session in the sidebar to open it here.
      </div>
    )
  }

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='h-9 shrink-0 flex items-center gap-2 px-4 border-b border-(--vscode-panel-border,transparent)'>
        <span className='codicon codicon-comment-discussion text-vs-desc' />
        <span className='text-sm truncate text-vs-fg'>{title}</span>
        <span className='ml-auto text-xs text-vs-desc'>{STATUS_LABEL[status]}</span>
      </div>

      <div ref={scrollRef} className='flex-1 min-h-0 overflow-y-auto px-4 py-3'>
        {messages.length === 0 ? (
          <div className='py-6 text-center text-vs-desc text-sm'>Send a message to start.</div>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} />)
        )}
      </div>

      <div className='shrink-0 border-t border-(--vscode-panel-border,transparent) px-3 py-2'>
        {permission && (
          <div className='mb-2 rounded border border-(--vscode-inputValidation-warningBorder,transparent) bg-(--vscode-inputValidation-warningBackground) px-3 py-2 text-xs text-vs-fg'>
            <div className='mb-1.5'>{permission.title ?? `Allow ${permission.displayName ?? permission.toolName}?`}</div>
            <div className='flex gap-2'>
              <button className='rounded px-2 py-0.5 bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90' onClick={() => respond(true)}>
                Approve
              </button>
              <button className='rounded px-2 py-0.5 bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90' onClick={() => respond(false)}>
                Deny
              </button>
            </div>
          </div>
        )}
        <div className='flex items-end gap-2'>
          <textarea
            className='flex-1 resize-none rounded px-2 py-1.5 text-sm outline-none bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-(--vscode-input-border,transparent) focus:border-(--vscode-focusBorder) placeholder:text-vs-desc'
            rows={2}
            placeholder='Message Claude…  (Enter to send, Shift+Enter for newline)'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <button className='rounded px-2 py-1.5 text-sm bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:opacity-90' title='Interrupt' onClick={interrupt}>
              <span className='codicon codicon-debug-stop' />
            </button>
          ) : (
            <button className='rounded px-2 py-1.5 text-sm bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:opacity-90 disabled:opacity-50' title='Send' disabled={!input.trim()} onClick={send}>
              <span className='codicon codicon-send' />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
