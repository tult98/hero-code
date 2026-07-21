import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '../../chat/types.js'
import { Markdown } from './Markdown.js'

/**
 * Plan-approval prompt — the webview counterpart of the terminal's `ExitPlanMode`
 * gate. Renders the plan as markdown (not a raw JSON tool-call dump) and offers the
 * same three choices as the terminal: use auto mode, manually approve edits, or tell
 * Claude what to change. The first two approve and hand off to the matching permission
 * mode; the third denies and forwards the typed feedback as the plan's revision note.
 * Full keyboard nav (↑↓, 1–3, Enter, Esc) mirrors {@link ApprovalPanel}.
 */

/** Theme tokens over `var(--vscode-*)`; plan accent pinned green (matches the `plan` mode chip). */
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
  inp: 'var(--vscode-input-background)',
  ac: '#5fd39a',
  acSoft: 'rgba(95,211,154,0.12)',
  acBd: 'rgba(95,211,154,0.44)',
}
const DANGER = '#e0574f'

/** Grow the feedback textarea to fit its content, up to a cap. */
const FEEDBACK_MAX_H = 110
const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) {
    return
  }
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, FEEDBACK_MAX_H)
  el.style.height = `${next}px`
  el.style.overflowY = el.scrollHeight > FEEDBACK_MAX_H ? 'auto' : 'hidden'
}

/** One radio option in the plan-approval list. */
interface Opt {
  id: 'auto' | 'accept' | 'tell'
  label: string
  icon: string
  hint?: string
}

const OPTIONS: Opt[] = [
  { id: 'auto', label: 'Yes, and use auto mode', icon: 'codicon-rocket', hint: 'auto-approve edits' },
  { id: 'accept', label: 'Yes, manually approve edits', icon: 'codicon-check', hint: 'ask per edit' },
  { id: 'tell', label: 'Tell Claude what to change', icon: 'codicon-comment', hint: 'keep planning' },
]

interface PlanApprovalPanelProps {
  request: PermissionRequest
  /** Resolve the parked `ExitPlanMode` call. `auto`/`acceptEdits` approve; `no` + `amend` denies with feedback. */
  onDecision: (decision: 'yes' | 'always' | 'no', amend?: string, mode?: 'auto' | 'acceptEdits') => void
  /** Dismiss without approving — resolves as a denial and returns the composer. */
  onDismiss: () => void
}

export function PlanApprovalPanel({ request, onDecision, onDismiss }: PlanApprovalPanelProps) {
  const [cursor, setCursor] = useState(0)
  const [telling, setTelling] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  // Grab focus on mount so keyboard nav works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const choose = (id: Opt['id']) => {
    if (id === 'auto') {
      onDecision('yes', undefined, 'auto')
    } else if (id === 'accept') {
      onDecision('yes', undefined, 'acceptEdits')
    } else {
      // "Tell Claude what to change": first press reveals the feedback box; a second
      // press (or Enter in the box) denies the plan and sends the note as its revision.
      if (!telling) {
        setTelling(true)
        setCursor(2)
        setTimeout(() => feedbackRef.current?.focus(), 30)
        return
      }
      onDecision('no', feedback.trim() || undefined)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inInput = (e.target as HTMLElement).tagName?.toLowerCase() === 'textarea'
    if (e.key === 'Escape') {
      e.preventDefault()
      if (inInput) {
        feedbackRef.current?.blur()
        rootRef.current?.focus()
        setTelling(false)
      } else {
        onDismiss()
      }
      return
    }
    // Inside the feedback box: plain Enter submits the denial, everything else is native.
    if (inInput) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        choose('tell')
      }
      return
    }
    if (e.key >= '1' && e.key <= String(OPTIONS.length)) {
      e.preventDefault()
      const i = Number(e.key) - 1
      setCursor(i)
      choose(OPTIONS[i].id)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(OPTIONS.length - 1, c + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(OPTIONS[cursor].id)
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        border: `1px solid ${T.cardBd}`,
        borderTop: `2px solid ${T.ac}`,
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
        <i className='codicon codicon-checklist' style={{ fontSize: '15px', color: T.ac, flex: '0 0 auto' }} />
        <span style={{ fontSize: '12.5px', fontWeight: 600, color: T.fg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>Plan ready</span>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontSize: '10.5px', fontWeight: 600, color: T.ac, fontFamily: 'Menlo, Consolas, monospace', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '5px', animation: 'scpulse 2s ease-in-out infinite' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: T.ac, display: 'block' }} />
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
      <div style={{ flex: '0 0 auto', maxHeight: '360px', overflowY: 'auto', overflowX: 'hidden', padding: '11px 12px 4px' }}>
        {/* PLAN MARKDOWN */}
        <div style={{ border: `1px solid ${T.bd}`, borderLeft: `2px solid ${T.ac}`, borderRadius: '8px', background: T.codeBg, padding: '9px 12px', marginBottom: '11px' }}>
          {request.planMarkdown ? <Markdown text={request.planMarkdown} /> : <span style={{ color: T.fgM }}>Claude is ready to execute its plan.</span>}
        </div>

        {/* PROMPT */}
        <div style={{ fontSize: '12.5px', fontWeight: 600, color: T.fg, marginBottom: '6px' }}>Claude has written up a plan and is ready to execute. Would you like to proceed?</div>

        {/* OPTIONS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {OPTIONS.map((o, i) => {
            const sel = cursor === i
            const isTell = o.id === 'tell'
            const accent = isTell ? DANGER : T.ac
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
                  {isTell && telling && (
                    <textarea
                      ref={feedbackRef}
                      value={feedback}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        setFeedback(e.target.value)
                        autoGrow(e.target)
                      }}
                      placeholder='Tell Claude what to change…'
                      rows={1}
                      style={{ marginTop: '7px', width: '100%', resize: 'none', background: T.inp, border: `1px solid ${DANGER}`, borderRadius: '6px', outline: 'none', color: T.fg, fontSize: '11.5px', lineHeight: 1.45, padding: '5px 8px', minHeight: '34px', fontFamily: 'inherit' }}
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
          <span style={{ flex: 1 }} />
          <span>
            <b style={{ color: T.fgM }}>Esc</b> cancel
          </span>
        </div>
      </div>
    </div>
  )
}
