import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AskQuestionItem, AskQuestionRequest } from '../../chat/types.js'

/**
 * The AskUserQuestion picker — docks in place of the composer while Claude waits
 * on a decision. A step-per-question flow: radios for single-select, checkboxes
 * for multi, a "type something else" free-text escape hatch. There is no review
 * step — picking a single-select option submits straight away (or advances to the
 * next question in a multi-question call); multi-select and custom answers submit
 * via the footer button. Full keyboard + click. Ported from the Claude Design
 * `Ask Question Panel`; colors follow VS Code theme variables with the pinned
 * Claude accent (like `ModelPanel`).
 */

/** Sentinel answer for the always-offered "type something else" free-text choice. */
const CUSTOM = '__custom__'

/** Cap for the content region; the panel fits the tallest step up to this, then scrolls. */
const MAX_H = 300

/** Tallest the free-text box grows before it scrolls internally. */
const INPUT_MAX_H = 76

/** Grow a textarea to fit its content (up to INPUT_MAX_H, then scroll). */
const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) {
    return
  }
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, INPUT_MAX_H)
  el.style.height = `${next}px`
  el.style.overflowY = el.scrollHeight > INPUT_MAX_H ? 'auto' : 'hidden'
}

/**
 * Theme tokens over `var(--vscode-*)` so the panel follows the active theme, with
 * the terracotta Claude accent pinned across light/dark. Mirrors `ModelPanel`'s `T`.
 */
const T = {
  fg: 'var(--vscode-foreground)',
  fgM: 'var(--vscode-descriptionForeground)',
  fgF: 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
  card: 'var(--vscode-editorWidget-background)',
  hdr: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background))',
  bd: 'var(--vscode-panel-border, var(--vscode-widget-border))',
  cardBd: 'var(--vscode-widget-border, var(--vscode-panel-border))',
  rowH: 'var(--vscode-list-hoverBackground)',
  inp: 'var(--vscode-input-background)',
  ac: '#d97757',
  acHover: '#e0886a',
  acT: '#1a1a1a',
  acSoft: 'rgba(217,119,87,0.13)',
  acBd: 'rgba(217,119,87,0.38)',
  mono: '#d99b82',
  ok: '#89d185',
}

interface AskQuestionPanelProps {
  request: AskQuestionRequest
  /** Deliver the answers (question text → chosen answer string) and satisfy the tool. */
  onSubmit: (answers: Record<string, string>) => void
  /** Dismiss without answering — the tool resolves benignly and the composer returns. */
  onDismiss: () => void
}

export function AskQuestionPanel({ request, onSubmit, onDismiss }: AskQuestionPanelProps) {
  const questions = request.questions
  const lastStep = questions.length - 1

  const [step, setStep] = useState(0)
  // Per-question index → selection: a label / CUSTOM (single), or a label[] (multi).
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [customActive, setCustomActive] = useState<Record<number, boolean>>({})
  const [cursor, setCursor] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputs = useRef<Record<number, HTMLTextAreaElement | null>>({})
  // Hidden copies of every step, measured once to pin the card to the tallest.
  const measureRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const [contentH, setContentH] = useState<number | null>(null)

  // Grab focus on mount so keyboard nav works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // Fit the content region to the tallest step (clamped to MAX_H, then it scrolls).
  // Bodies are static height, so one pass per request is enough.
  useLayoutEffect(() => {
    const max = Math.max(0, ...questions.map((_, i) => measureRefs.current[i]?.offsetHeight ?? 0))
    setContentH(Math.min(MAX_H, Math.ceil(max)))
  }, [request.requestId])

  const q = questions[step]
  const isLast = step === lastStep

  // Size this step's free-text box to its content, and focus it the moment the cursor
  // lands on it — typing "chooses" it.
  useEffect(() => {
    autoGrow(inputs.current[step])
    if (cursor === questions[step].options.length) {
      inputs.current[step]?.focus()
    }
  }, [cursor, step])

  const optionRows = (item: AskQuestionItem): string[] => [...item.options.map((o) => o.label), CUSTOM]

  const answered = (i: number): boolean => {
    const item = questions[i]
    const a = answers[i]
    const ct = (custom[i] || '').trim()
    if (item.multiSelect) {
      return (Array.isArray(a) && a.length > 0) || (!!customActive[i] && !!ct)
    }
    if (a === CUSTOM) {
      return !!ct
    }
    return !!a
  }

  /** The chosen answer(s) for question `i`, read from `src` (defaults to live state). */
  const answerParts = (i: number, src: Record<number, string | string[]> = answers): string[] => {
    const item = questions[i]
    const a = src[i]
    const ct = (custom[i] || '').trim()
    if (item.multiSelect) {
      const arr = Array.isArray(a) ? [...a] : []
      if (customActive[i] && ct) {
        arr.push(`“${ct}”`)
      }
      return arr
    }
    if (a === CUSTOM) {
      return ct ? [`“${ct}”`] : []
    }
    return typeof a === 'string' && a ? [a] : []
  }

  const goStep = (i: number) => {
    setStep(Math.max(0, Math.min(lastStep, i)))
    setCursor(0)
  }
  const prev = () => goStep(step - 1)
  const next = () => goStep(step + 1)

  /** Build the answer map and satisfy the tool. `src` lets an auto-submit include a just-made pick. */
  const submit = (src: Record<number, string | string[]> = answers) => {
    const out: Record<string, string> = {}
    questions.forEach((item, i) => {
      out[item.question] = answerParts(i, src).join(', ')
    })
    onSubmit(out)
  }

  const focusCustom = (i: number) => {
    setTimeout(() => inputs.current[i]?.focus(), 30)
  }

  const pickCustom = (i: number) => {
    const item = questions[i]
    if (item.multiSelect) {
      setCustomActive((s) => ({ ...s, [i]: !s[i] }))
    } else {
      setAnswers((s) => ({ ...s, [i]: CUSTOM }))
      setCustomActive((s) => ({ ...s, [i]: true }))
    }
    focusCustom(i)
  }

  /** Select/toggle an option. Selecting never advances — Enter/→/Next do that. */
  const select = (i: number, label: string) => {
    if (label === CUSTOM) {
      pickCustom(i)
      return
    }
    const item = questions[i]
    if (item.multiSelect) {
      setAnswers((s) => {
        const arr = Array.isArray(s[i]) ? [...(s[i] as string[])] : []
        const at = arr.indexOf(label)
        if (at >= 0) {
          arr.splice(at, 1)
        } else {
          arr.push(label)
        }
        return { ...s, [i]: arr }
      })
      return
    }
    setAnswers((s) => ({ ...s, [i]: label }))
    setCustomActive((s) => ({ ...s, [i]: false }))
  }

  /** Move to the next question, or submit when on the last. */
  const advance = () => {
    if (isLast) {
      submit()
    } else {
      next()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName?.toLowerCase()
    const inInput = tag === 'input' || tag === 'textarea'
    // Drop focus back to the root so key nav resumes once we leave the free-text box.
    const leaveInput = () => {
      if (inInput) {
        ;(e.target as HTMLElement).blur()
        rootRef.current?.focus()
      }
    }
    const toPrev = () => {
      leaveInput()
      if (step > 0) {
        prev()
      }
    }
    const toNext = () => {
      leaveInput()
      if (!isLast) {
        next()
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (inInput) {
        leaveInput()
      } else {
        onDismiss()
      }
      return
    }
    // Plain Enter advances (submits on the last); Shift+Enter is left native so the
    // textarea inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      leaveInput()
      advance()
      return
    }

    // Inside the free-text box, keep normal caret behavior: only jump questions/options
    // at the text boundaries, and let ⌘/Ctrl/Alt/Shift + arrows do native caret nav.
    if (inInput) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return
      }
      const el = e.target as HTMLTextAreaElement
      const collapsed = el.selectionStart === el.selectionEnd
      const at = el.selectionStart
      if (e.key === 'ArrowLeft' && collapsed && at === 0) {
        e.preventDefault()
        toPrev()
      } else if (e.key === 'ArrowRight' && collapsed && at === el.value.length) {
        e.preventDefault()
        toNext()
      } else if (e.key === 'ArrowUp' && collapsed && !el.value.slice(0, at).includes('\n')) {
        // On the first line → back up to the last option.
        e.preventDefault()
        leaveInput()
        setCursor(Math.max(0, q.options.length - 1))
      }
      return
    }

    // On the options: up/down move the cursor, left/right jump questions.
    const rows = optionRows(q)
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      toPrev()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      toNext()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(rows.length - 1, c + 1))
    } else if (e.key === ' ') {
      // Space selects/toggles the cursored option.
      e.preventDefault()
      select(step, rows[cursor])
    }
  }

  const stepCounter = `Q${step + 1}/${questions.length}`

  /**
   * The body for question `qi` — the "Pick one/any" line, the options, and the
   * always-visible free-text row. `measuring` renders an inert copy (no cursor
   * highlight, no handlers, no shared input ref) used only to size the card.
   */
  const renderBody = (qi: number, measuring = false) => {
    const item = questions[qi]
    const custIdx = item.options.length
    const cur = measuring ? -1 : qi === step ? cursor : -1
    const arr = answers[qi]
    const custSel = item.multiSelect ? !!customActive[qi] : arr === CUSTOM
    const custHi = cur === custIdx
    const custHovered = !measuring && hover === `custom:${qi}`
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', marginBottom: '9px' }}>
          <span style={{ flex: '0 0 auto', marginTop: '2px', fontSize: '9.5px', fontWeight: 700, color: T.ac, background: T.acSoft, border: `1px solid ${T.acBd}`, borderRadius: '5px', padding: '1px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <i className={`codicon ${item.multiSelect ? 'codicon-checklist' : 'codicon-circle-outline'}`} style={{ fontSize: '11px' }} />
            {item.multiSelect ? 'Pick any' : 'Pick one'}
          </span>
          <span style={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 700, color: T.fg, lineHeight: 1.35 }}>{item.question}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {item.options.map((o, oi) => {
            const sel = item.multiSelect ? Array.isArray(arr) && arr.includes(o.label) : arr === o.label
            const hi = cur === oi
            const key = `opt:${qi}:${oi}`
            const hovered = !measuring && hover === key
            return (
              <div
                key={oi}
                onClick={measuring ? undefined : () => {
                  setCursor(oi)
                  select(qi, o.label)
                }}
                onMouseEnter={measuring ? undefined : () => setHover(key)}
                onMouseLeave={measuring ? undefined : () => setHover(null)}
                style={{ display: 'flex', gap: '9px', padding: '8px 10px', cursor: 'pointer', borderRadius: '8px', border: `1px solid ${hi ? T.ac : sel ? T.acBd : hovered ? T.acBd : T.bd}`, background: hi ? T.acSoft : sel || hovered ? T.rowH : 'transparent' }}
              >
                <div style={{ flex: '0 0 auto', marginTop: '1px' }}>
                  {item.multiSelect ? (
                    <div style={{ width: '16px', height: '16px', borderRadius: '5px', border: `2px solid ${sel ? T.ac : T.cardBd}`, background: sel ? T.ac : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {sel && <i className='codicon codicon-check' style={{ fontSize: '11px', color: T.acT }} />}
                    </div>
                  ) : (
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${sel ? T.ac : T.cardBd}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {sel && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: T.ac, display: 'block' }} />}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: T.fgF, fontFamily: 'Menlo, Consolas, monospace', flex: '0 0 auto' }}>{oi + 1}.</span>
                    <span style={{ fontSize: '12.5px', fontWeight: 600, color: sel ? T.fg : T.ac, lineHeight: 1.3 }}>{o.label}</span>
                  </div>
                  {o.description && <div style={{ fontSize: '11px', marginTop: '2px', lineHeight: 1.4, color: T.fgM }}>{o.description}</div>}
                  {o.preview && <pre style={{ fontSize: '10.5px', marginTop: '5px', padding: '6px 8px', lineHeight: 1.45, color: T.fgM, background: T.inp, border: `1px solid ${T.bd}`, borderRadius: '6px', overflowX: 'auto', fontFamily: 'Menlo, Consolas, monospace', whiteSpace: 'pre' }}>{o.preview}</pre>}
                </div>
              </div>
            )
          })}

          {/* CUSTOM — always-visible free-text row; focusing it "chooses" it. */}
          <div
            onClick={measuring ? undefined : () => inputs.current[qi]?.focus()}
            onMouseEnter={measuring ? undefined : () => setHover(`custom:${qi}`)}
            onMouseLeave={measuring ? undefined : () => setHover(null)}
            style={{ display: 'flex', gap: '9px', padding: '8px 10px', cursor: 'text', alignItems: 'flex-start', borderRadius: '8px', border: `1px solid ${custHi ? T.ac : custSel ? T.acBd : custHovered ? T.acBd : T.bd}`, background: custHi ? T.acSoft : custSel || custHovered ? T.rowH : 'transparent' }}
          >
            <div style={{ flex: '0 0 auto', marginTop: '1px' }}>
              {item.multiSelect ? (
                <div style={{ width: '16px', height: '16px', borderRadius: '5px', border: `2px solid ${custSel ? T.ac : T.cardBd}`, background: custSel ? T.ac : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {custSel && <i className='codicon codicon-check' style={{ fontSize: '11px', color: T.acT }} />}
                </div>
              ) : (
                <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${custSel ? T.ac : T.cardBd}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {custSel && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: T.ac, display: 'block' }} />}
                </div>
              )}
            </div>
            <i className='codicon codicon-edit' style={{ fontSize: '12px', color: custSel ? T.ac : T.fgM, flex: '0 0 auto', marginTop: '3px' }} />
            <textarea
              ref={measuring ? undefined : (el) => {
                inputs.current[qi] = el
                autoGrow(el)
              }}
              value={custom[qi] || ''}
              onChange={(e) => {
                const v = e.target.value
                setCustom((s) => ({ ...s, [qi]: v }))
                autoGrow(e.target)
              }}
              onFocus={measuring ? undefined : () => {
                setCursor(custIdx)
                setCustomActive((s) => ({ ...s, [qi]: true }))
                if (!item.multiSelect) {
                  setAnswers((s) => ({ ...s, [qi]: CUSTOM }))
                }
              }}
              onPaste={measuring ? undefined : (e) => {
                // The answer is text-only, so swallow image pastes (they'd dump nothing
                // useful); plain text still pastes normally.
                if (Array.from(e.clipboardData?.items ?? []).some((it) => it.type.startsWith('image/'))) {
                  e.preventDefault()
                }
              }}
              placeholder={item.multiSelect ? 'Type your own option…' : 'Type something else…'}
              rows={1}
              style={{ flex: 1, minWidth: 0, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: T.fg, fontSize: '12.5px', fontWeight: 400, lineHeight: 1.45, padding: 0, fontFamily: 'inherit', overflowX: 'hidden' }}
            />
          </div>
        </div>
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        position: 'relative',
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
        <i className='codicon codicon-comment-discussion' style={{ fontSize: '15px', color: T.ac, flex: '0 0 auto' }} />
        <span style={{ fontSize: '12.5px', fontWeight: 600, color: T.fg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>Claude needs input</span>
        <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '9.5px', fontWeight: 600, color: T.mono, background: T.acSoft, border: `1px solid ${T.acBd}`, borderRadius: '5px', padding: '1px 5px', flex: '0 0 auto' }}>AskUserQuestion</span>
        <span style={{ flex: 1, minWidth: 0 }} />
        {questions.length > 1 && <span style={{ fontSize: '10.5px', fontWeight: 600, color: T.fgM, fontFamily: 'Menlo, Consolas, monospace', flex: '0 0 auto' }}>{stepCounter}</span>}
        <i
          className='codicon codicon-close'
          title='Dismiss (Esc)'
          onClick={onDismiss}
          onMouseEnter={() => setHover('close')}
          onMouseLeave={() => setHover(null)}
          style={{ fontSize: '14px', color: hover === 'close' ? T.fg : T.fgM, background: hover === 'close' ? T.rowH : 'transparent', cursor: 'pointer', padding: '2px', borderRadius: '5px', flex: '0 0 auto' }}
        />
      </div>

      {/* STEP DOTS (multi-question only) */}
      {questions.length > 1 && (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 10px', borderBottom: `1px solid ${T.bd}`, overflowX: 'auto' }}>
          {questions.map((item, i) => {
            const active = step === i
            const done = answered(i)
            return (
              <div
                key={i}
                onClick={() => goStep(i)}
                title={item.question}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '3px 9px', borderRadius: '20px', cursor: 'pointer', whiteSpace: 'nowrap', flex: '0 0 auto', background: active ? T.acSoft : 'transparent', border: `1px solid ${active ? T.acBd : T.bd}`, color: active ? T.ac : T.fgM }}
              >
                {done && !active ? (
                  <i className='codicon codicon-check' style={{ fontSize: '12px', color: T.ok }} />
                ) : (
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: active ? T.ac : T.fgF, display: 'block', flex: '0 0 7px' }} />
                )}
                <span style={{ fontSize: '11px', fontWeight: 600 }}>{item.header}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* QUESTION VIEW — height pinned to the tallest step (see measuring layer below). */}
      <div style={{ flex: '0 0 auto', height: contentH ?? MAX_H, boxSizing: 'border-box', overflowY: 'auto', overflowX: 'hidden', padding: '11px 11px 4px' }}>
        {renderBody(step)}
      </div>

      {/* MEASURING LAYER — inert copies of every step, off-screen, sized once to fix the card height. */}
      <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: 0, visibility: 'hidden', pointerEvents: 'none', zIndex: -1 }}>
        {questions.map((_, i) => (
          <div
            key={i}
            ref={(el) => {
              measureRefs.current[i] = el
            }}
            style={{ boxSizing: 'border-box', padding: '11px 11px 4px' }}
          >
            {renderBody(i, true)}
          </div>
        ))}
      </div>

      {/* FOOTER */}
      <div style={{ flex: '0 0 auto', borderTop: `1px solid ${T.bd}`, background: T.hdr, padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {step > 0 && (
            <div
              onClick={prev}
              title='Back (←)'
              onMouseEnter={() => setHover('back')}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', border: `1px solid ${hover === 'back' ? T.ac : T.cardBd}`, color: hover === 'back' ? T.ac : T.fg, fontWeight: 600, fontSize: '11.5px', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', flex: '0 0 auto' }}
            >
              <i className='codicon codicon-arrow-left' style={{ fontSize: '12px' }} />
              Back
            </div>
          )}
          <span style={{ flex: 1, minWidth: 0, fontSize: '10.5px', color: T.fgF, display: 'flex', alignItems: 'center', gap: '9px', overflow: 'hidden' }}>
            <span style={{ flex: '0 0 auto' }}>
              <b style={{ color: T.fgM }}>space</b> select
            </span>
            <span style={{ flex: '0 0 auto' }}>
              <b style={{ color: T.fgM }}>↵</b> {isLast ? 'submit' : 'next'}
            </span>
            {questions.length > 1 && (
              <span style={{ flex: '0 0 auto' }}>
                <b style={{ color: T.fgM }}>←→</b> jump
              </span>
            )}
            <span style={{ flex: '0 0 auto' }}>
              <b style={{ color: T.fgM }}>⇧↵</b> newline
            </span>
          </span>
          {isLast ? (
            <div
              onClick={() => submit()}
              onMouseEnter={() => setHover('submit')}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', background: hover === 'submit' ? T.acHover : T.ac, color: T.acT, fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '6px 13px', cursor: 'pointer', flex: '0 0 auto' }}
            >
              <i className='codicon codicon-send' style={{ fontSize: '12px' }} />
              Submit
            </div>
          ) : (
            <div
              onClick={next}
              onMouseEnter={() => setHover('next')}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', background: hover === 'next' ? T.acHover : T.ac, color: T.acT, fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '6px 13px', cursor: 'pointer', flex: '0 0 auto' }}
            >
              Next
              <i className='codicon codicon-arrow-right' style={{ fontSize: '12px' }} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
