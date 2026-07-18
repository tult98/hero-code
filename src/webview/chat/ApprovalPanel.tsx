import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '../../chat/types.js'

/**
 * Tool-approval prompt — takes over the composer while Claude waits for
 * permission to run a risky tool. Shows the risk class, the exact command, an
 * optional blocker note, an expandable input inspector, and three radios:
 * Yes / Yes & always allow / No. Destructive tools flip the accent red;
 * write/network/MCP use amber. Full keyboard (↑↓, 1–3, Enter, Tab, ^E, Esc) +
 * click. Ported from the Claude Design `Approval Panel`; base colors follow VS
 * Code theme variables with a pinned Claude accent (like `AskQuestionPanel`).
 */

/** Fixed risk accents — read acceptably on both light and dark cards. */
const DANGER = { ac: '#e0574f', soft: 'rgba(224,87,79,0.12)', bd: 'rgba(224,87,79,0.44)' }
const WARN = { ac: '#d9a441', soft: 'rgba(217,164,65,0.14)', bd: 'rgba(217,164,65,0.46)' }

/** Grow the amend textarea to fit its content, up to a cap. */
const AMEND_MAX_H = 90
const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) {
    return
  }
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, AMEND_MAX_H)
  el.style.height = `${next}px`
  el.style.overflowY = el.scrollHeight > AMEND_MAX_H ? 'auto' : 'hidden'
}

/** Theme tokens over `var(--vscode-*)`; Claude accent pinned. Mirrors `AskQuestionPanel`'s `T`. */
const T = {
  fg: 'var(--vscode-foreground)',
  fgM: 'var(--vscode-descriptionForeground)',
  fgF: 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
  card: 'var(--vscode-editorWidget-background)',
  hdr: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background))',
  bd: 'var(--vscode-panel-border, var(--vscode-widget-border))',
  cardBd: 'var(--vscode-widget-border, var(--vscode-panel-border))',
  rowH: 'var(--vscode-list-hoverBackground)',
  codeBg: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))',
  code: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
  codeAc: '#d99b82',
  inp: 'var(--vscode-input-background)',
  ac: '#d97757',
  acT: '#1a1a1a',
  mono: '#d99b82',
  ok: '#89d185',
}

/** One radio option in the approve/deny list. */
interface Opt {
  id: 'yes' | 'always' | 'no'
  label: string
  icon: string
  hint?: string
}

interface ApprovalPanelProps {
  request: PermissionRequest
  /** Resolve the parked tool call; `amend` (Yes only) is queued as the next user turn. */
  onDecision: (decision: 'yes' | 'always' | 'no', amend?: string) => void
  /** Dismiss without approving — resolves as a denial and returns the composer. */
  onDismiss: () => void
}

export function ApprovalPanel({ request, onDecision, onDismiss }: ApprovalPanelProps) {
  const [cursor, setCursor] = useState(0)
  const [amending, setAmending] = useState(false)
  const [amendText, setAmendText] = useState('')
  const [explaining, setExplaining] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const amendRef = useRef<HTMLTextAreaElement>(null)

  // Grab focus on mount so keyboard nav works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const risk = request.risk === 'high' ? DANGER : WARN

  const options: Opt[] = [
    { id: 'yes', label: amending ? 'Yes,' : 'Yes', icon: 'codicon-check' },
    ...(request.canAlways
      ? [
          {
            id: 'always' as const,
            label: `Yes, and always allow ${request.badge}${request.alwaysLabel ? ` for ${request.alwaysLabel}` : ''}`,
            icon: 'codicon-verified',
            hint: 'won’t ask again',
          },
        ]
      : []),
    { id: 'no', label: 'No, keep asking', icon: 'codicon-close' },
  ]

  const choose = (id: Opt['id']) => {
    if (id === 'yes') {
      onDecision('yes', amending && amendText.trim() ? amendText.trim() : undefined)
    } else {
      onDecision(id)
    }
  }

  const toggleAmend = () => {
    const next = !amending
    setAmending(next)
    if (next) {
      setCursor(0)
      setTimeout(() => amendRef.current?.focus(), 30)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName?.toLowerCase()
    const inInput = tag === 'textarea'
    // ^E / ⌘E toggles the input inspector (only when there's something to show).
    if (request.explain && e.key.toLowerCase() === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setExplaining((x) => !x)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      toggleAmend()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (inInput) {
        amendRef.current?.blur()
        rootRef.current?.focus()
        setAmending(false)
      } else {
        onDismiss()
      }
      return
    }
    // Inside the amend box: plain Enter approves, everything else is native caret nav.
    if (inInput) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        choose('yes')
      }
      return
    }
    if (e.key >= '1' && e.key <= String(options.length)) {
      e.preventDefault()
      const i = Number(e.key) - 1
      if (options[i]) {
        setCursor(i)
        choose(options[i].id)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(options.length - 1, c + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(options[cursor].id)
    }
  }

  const sp = request.command.indexOf(' ')
  const cmdHead = sp > 0 ? request.command.slice(0, sp + 1) : ''
  const cmdRest = sp > 0 ? request.command.slice(sp + 1) : request.command

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        border: `1px solid ${T.cardBd}`,
        borderTop: `2px solid ${risk.ac}`,
        borderRadius: '11px',
        background: T.card,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontSize: '13px',
        color: T.fg,
      }}
    >
      {/* HEADER */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 9px 8px 10px', borderBottom: `1px solid ${T.bd}`, background: T.hdr }}>
        <i className='codicon codicon-shield' style={{ fontSize: '15px', color: risk.ac, flex: '0 0 auto' }} />
        <span style={{ fontSize: '12.5px', fontWeight: 600, color: T.fg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>Approval required</span>
        <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '9.5px', fontWeight: 600, color: T.mono, background: risk.soft, border: `1px solid ${risk.bd}`, borderRadius: '5px', padding: '1px 5px', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <i className={`codicon ${request.badgeIcon}`} style={{ fontSize: '10px' }} />
          {request.badge}
        </span>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontSize: '10.5px', fontWeight: 600, color: risk.ac, fontFamily: 'Menlo, Consolas, monospace', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '5px', animation: 'scpulse 2s ease-in-out infinite' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: risk.ac, display: 'block' }} />
          waiting
        </span>
        <i
          onClick={onDismiss}
          title='Cancel (Esc)'
          className='codicon codicon-close'
          style={{ fontSize: '14px', color: hover === 'x' ? T.fg : T.fgM, cursor: 'pointer', padding: '2px', borderRadius: '5px', flex: '0 0 auto', background: hover === 'x' ? T.rowH : 'transparent' }}
          onMouseEnter={() => setHover('x')}
          onMouseLeave={() => setHover(null)}
        />
      </div>

      {/* BODY */}
      <div style={{ flex: '0 0 auto', maxHeight: '340px', overflowY: 'auto', overflowX: 'hidden', padding: '11px 11px 4px' }}>
        {/* RISK LINE */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', marginBottom: '10px' }}>
          <span style={{ flex: '0 0 auto', marginTop: '1px', fontSize: '9.5px', fontWeight: 700, color: risk.ac, background: risk.soft, border: `1px solid ${risk.bd}`, borderRadius: '5px', padding: '2px 7px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
            <i className={`codicon ${request.riskIcon}`} style={{ fontSize: '11px' }} />
            {request.riskLabel}
          </span>
          <span style={{ flex: 1, minWidth: 0, fontSize: '13.5px', fontWeight: 700, color: T.fg, lineHeight: 1.35 }}>
            {request.title ?? `Allow ${request.displayName ?? request.toolName}?`}
          </span>
        </div>

        {/* COMMAND BLOCK */}
        <div style={{ border: `1px solid ${T.bd}`, borderLeft: `2px solid ${risk.ac}`, borderRadius: '8px', background: T.codeBg, overflow: 'hidden', marginBottom: '9px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '6px 10px', borderBottom: `1px solid ${T.bd}` }}>
            <i className={`codicon ${request.badgeIcon}`} style={{ fontSize: '12px', color: T.fgM }} />
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: T.fgM }}>{request.blockLabel}</span>
          </div>
          <div style={{ padding: '9px 11px' }}>
            <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '12px', lineHeight: 1.5, color: T.code, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {cmdHead && <span style={{ color: T.codeAc }}>{cmdHead}</span>}
              {cmdRest}
            </div>
            {request.description && <div style={{ fontSize: '11px', color: T.fgM, marginTop: '5px', lineHeight: 1.45 }}>{request.description}</div>}
            {explaining && request.explain && (
              <div style={{ marginTop: '8px', borderTop: `1px solid ${T.bd}`, paddingTop: '8px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: T.fgM, marginBottom: '5px' }}>Full input</div>
                <pre style={{ margin: 0, fontFamily: 'Menlo, Consolas, monospace', fontSize: '11px', lineHeight: 1.5, color: T.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{request.explain}</pre>
              </div>
            )}
          </div>
        </div>

        {/* NOTE / WARNING */}
        {request.note && (
          <div style={{ display: 'flex', gap: '7px', alignItems: 'flex-start', background: risk.soft, border: `1px solid ${risk.bd}`, borderRadius: '8px', padding: '8px 10px', marginBottom: '11px' }}>
            <i className='codicon codicon-warning' style={{ fontSize: '13px', color: risk.ac, flex: '0 0 auto', marginTop: '1px' }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: '11.5px', color: T.fg, lineHeight: 1.45 }}>{request.note}</span>
          </div>
        )}

        {/* PROMPT */}
        <div style={{ fontSize: '12.5px', fontWeight: 600, color: T.fg, marginBottom: '6px' }}>Do you want to proceed?</div>

        {/* OPTIONS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {options.map((o, i) => {
            const sel = cursor === i
            const isNo = o.id === 'no'
            const accent = isNo ? DANGER.ac : risk.ac
            const key = `opt:${o.id}`
            const hovered = hover === key
            return (
              <div
                key={o.id}
                onClick={() => {
                  setCursor(i)
                  choose(o.id)
                }}
                onMouseEnter={() => setHover(key)}
                onMouseLeave={() => setHover(null)}
                style={{ display: 'flex', gap: '9px', alignItems: 'center', padding: '8px 10px', cursor: 'pointer', borderRadius: '8px', border: `1px solid ${sel ? `${accent}88` : hovered ? T.cardBd : T.bd}`, background: sel ? `${accent}14` : hovered ? T.rowH : 'transparent' }}
              >
                <div style={{ flex: '0 0 auto', width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${sel ? accent : T.cardBd}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {sel && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: accent, display: 'block' }} />}
                </div>
                <span style={{ fontSize: '10px', fontWeight: 700, color: T.fgF, fontFamily: 'Menlo, Consolas, monospace', flex: '0 0 auto' }}>{i + 1}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600, color: sel ? T.fg : T.fgM, lineHeight: 1.3 }}>{o.label}</span>
                  {o.hint && <span style={{ fontSize: '10.5px', color: T.fgF, marginLeft: '6px' }}>{o.hint}</span>}
                  {o.id === 'yes' && amending && (
                    <textarea
                      ref={amendRef}
                      value={amendText}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        setAmendText(e.target.value)
                        autoGrow(e.target)
                      }}
                      placeholder='and tell Claude what to do next…'
                      rows={1}
                      style={{ marginTop: '7px', width: '100%', resize: 'none', background: T.inp, border: `1px solid ${risk.ac}`, borderRadius: '6px', outline: 'none', color: T.fg, fontSize: '11.5px', lineHeight: 1.45, padding: '5px 8px', minHeight: '32px', fontFamily: 'inherit' }}
                    />
                  )}
                </div>
                <i className={`codicon ${o.icon}`} style={{ fontSize: '13px', color: sel ? accent : T.fgF, flex: '0 0 auto' }} />
              </div>
            )
          })}
        </div>
      </div>

      {/* FOOTER */}
      <div style={{ flex: '0 0 auto', borderTop: `1px solid ${T.bd}`, background: T.hdr, padding: '8px 11px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '13px', fontSize: '10.5px', color: T.fgF, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          <span>
            <b style={{ color: T.fgM }}>↑↓</b> move
          </span>
          <span>
            <b style={{ color: T.fgM }}>↵</b> select
          </span>
          <span>
            <b style={{ color: T.fgM }}>Tab</b> amend
          </span>
          {request.explain && (
            <span>
              <b style={{ color: T.fgM }}>^E</b> {explaining ? 'hide' : 'explain'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span>
            <b style={{ color: T.fgM }}>Esc</b> cancel
          </span>
        </div>
      </div>
    </div>
  )
}
