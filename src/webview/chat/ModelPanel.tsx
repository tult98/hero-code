import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelChoice } from '../../chat/types.js'

/** Panel view driven by the host's `models` message. */
export type ModelPanelStatus = 'loading' | 'ready' | 'empty' | 'error'

interface ModelPanelProps {
  status: ModelPanelStatus
  models: ModelChoice[]
  /** Live session model (`value` of the matching row), gets the green check. */
  currentValue?: string
  /** Saved default model (`value`), tagged in the list. */
  defaultValue?: string
  /** Live reasoning effort, seeds the effort control. */
  currentEffort?: string
  error?: string
  /** Commit a pick as the new default (persisted) or for this session only. */
  onCommit: (value: string, effort: string | undefined, scope: 'default' | 'session') => void
  onRefresh: () => void
  onClose: () => void
}

const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'max']

/**
 * Theme tokens mapped onto VS Code CSS variables so the panel adapts to any
 * theme, with the pinned Claude accent (`#d97757`) kept across light/dark. Mirrors
 * the `t` object in the Claude Design `Model Panel` source.
 */
const T = {
  fg: 'var(--vscode-foreground)',
  fgM: 'var(--vscode-descriptionForeground)',
  fgF: 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
  hdr: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background))',
  bd: 'var(--vscode-panel-border, var(--vscode-widget-border))',
  bd2: 'var(--vscode-widget-border, var(--vscode-panel-border))',
  rowH: 'var(--vscode-list-hoverBackground)',
  card: 'var(--vscode-editorWidget-background)',
  seg: 'var(--vscode-input-background)',
  ac: '#d97757',
  acHover: '#e0886a',
  acT: '#1a1a1a',
  acSoft: 'rgba(217,119,87,0.13)',
  acBd: 'rgba(217,119,87,0.38)',
  mono: '#d99b82',
  ok: '#89d185',
  err: '#f14c4c',
  skel1: 'var(--vscode-editorWidget-background)',
  skel2: 'var(--vscode-list-hoverBackground)',
  scrim: 'color-mix(in srgb, var(--vscode-editor-background) 82%, transparent)',
}

const chip: React.CSSProperties = {
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: '10.5px',
  fontWeight: 600,
  color: T.mono,
}

/** The Claude `/model` picker — takes over the chat view. */
export function ModelPanel({ status, models, currentValue, defaultValue, currentEffort, error, onCommit, onRefresh, onClose }: ModelPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const [effort, setEffort] = useState<string | undefined>(undefined)
  const [hover, setHover] = useState<string | null>(null)

  // Grab focus on mount so keyboard nav works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // The effective selection defaults to the current/first model until the user picks.
  const sel = selected ?? currentValue ?? models[0]?.value
  const selModel = models.find((m) => m.value === sel)
  const efforts = selModel && selModel.effortLevels.length > 0 ? selModel.effortLevels : selModel ? [] : FALLBACK_EFFORTS
  const eff = useMemo(() => {
    if (efforts.length === 0) {
      return undefined
    }
    const wanted = effort ?? currentEffort
    return wanted && efforts.includes(wanted) ? wanted : efforts.includes('high') ? 'high' : efforts[0]
  }, [effort, currentEffort, efforts])

  const clampCursor = (c: number) => Math.max(0, Math.min(models.length - 1, c))
  const moveCursor = (d: number) => {
    if (!models.length) {
      return
    }
    const base = cursor || Math.max(0, models.findIndex((m) => m.value === sel))
    const next = clampCursor(base + d)
    setCursor(next)
    setSelected(models[next]?.value)
  }
  const adjustEffort = (d: number) => {
    if (!eff || efforts.length === 0) {
      return
    }
    const i = efforts.indexOf(eff)
    setEffort(efforts[Math.max(0, Math.min(efforts.length - 1, i + d))])
  }

  // Commit closes the panel (the parent handles closing + refocusing the chat).
  const commit = (scope: 'default' | 'session') => {
    if (!selModel) {
      return
    }
    onCommit(selModel.value, eff, scope)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (status !== 'ready') {
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveCursor(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveCursor(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      adjustEffort(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      adjustEffort(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit('default')
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault()
      commit('session')
    }
  }

  const iconBtn = (key: string): React.CSSProperties => ({
    fontSize: '15px',
    color: hover === key ? T.fg : T.fgM,
    background: hover === key ? T.rowH : 'transparent',
    cursor: 'pointer',
    padding: '3px',
    borderRadius: '5px',
    flex: '0 0 auto',
  })

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        outline: 'none',
        background: 'var(--vscode-editor-background)',
        color: T.fg,
        fontSize: '13px',
      }}
    >
      {/* HEADER */}
      <div style={{ flex: '0 0 auto', background: T.hdr, borderBottom: `1px solid ${T.bd}`, borderTop: `2px solid ${T.ac}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 9px 7px 6px' }}>
          <i
            className='codicon codicon-arrow-left'
            title='Back to chat'
            onClick={onClose}
            onMouseEnter={() => setHover('back')}
            onMouseLeave={() => setHover(null)}
            style={{ ...iconBtn('back'), fontSize: '16px' }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: T.fg, whiteSpace: 'nowrap' }}>Select model</span>
            <span style={{ ...chip, background: T.acSoft, border: `1px solid ${T.acBd}`, borderRadius: '5px', padding: '1px 6px', flex: '0 0 auto' }}>/model</span>
          </div>
          <i
            className='codicon codicon-refresh'
            title='Refresh model catalog'
            onClick={onRefresh}
            onMouseEnter={() => setHover('refresh')}
            onMouseLeave={() => setHover(null)}
            style={{ ...iconBtn('refresh'), animation: status === 'loading' ? 'spin .8s linear infinite' : 'none' }}
          />
          <i
            className='codicon codicon-close'
            title='Close (Esc)'
            onClick={onClose}
            onMouseEnter={() => setHover('close')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('close')}
          />
        </div>
        <div style={{ padding: '0 12px 9px 33px', fontSize: '11.5px', color: T.fgM, lineHeight: 1.5 }}>
          Switch between Claude models. Your pick becomes the default for new sessions. For other or previous models, specify with <span style={{ ...chip, color: T.mono }}>--model</span>.
        </div>
      </div>

      {/* READY */}
      {status === 'ready' && (
        <>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px' }}>
            {models.map((m, i) => {
              const isSel = m.value === sel
              const isCur = m.value === currentValue
              const isHi = i === cursor && (cursor !== 0 || sel === models[0]?.value)
              const bg = isHi ? T.acSoft : isSel || hover === `row:${i}` ? T.rowH : 'transparent'
              return (
                <div
                  key={m.value}
                  onClick={() => {
                    setSelected(m.value)
                    setCursor(i)
                  }}
                  onMouseEnter={() => setHover(`row:${i}`)}
                  onMouseLeave={() => setHover(null)}
                  style={{
                    display: 'flex',
                    gap: '11px',
                    padding: '9px 11px 10px',
                    cursor: 'pointer',
                    borderRadius: '8px',
                    marginBottom: '2px',
                    borderLeft: `2px solid ${isHi ? T.ac : 'transparent'}`,
                    background: bg,
                    boxShadow: isHi ? `inset 0 0 0 1px ${T.acBd}` : 'none',
                  }}
                >
                  <div style={{ width: '17px', height: '17px', borderRadius: '50%', flex: '0 0 17px', marginTop: '2px', border: `2px solid ${isSel ? T.ac : T.bd2}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isSel && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: T.ac, display: 'block' }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: T.fg }}>{m.displayName}</span>
                      {isCur && <span style={{ fontSize: '11px', color: T.fgM, fontWeight: 500 }}>· current</span>}
                      {m.value === defaultValue && !isCur && <span style={{ fontSize: '11px', color: T.fgM, fontWeight: 400 }}>· default</span>}
                    </div>
                    <div style={{ fontSize: '11.5px', marginTop: '3px', lineHeight: 1.45, color: T.fgM }}>{m.description}</div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* EFFORT */}
          {efforts.length > 0 && (
            <div style={{ flex: '0 0 auto', padding: '10px 13px 11px', borderTop: `1px solid ${T.bd}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: T.ac, flex: '0 0 8px' }} />
                <span style={{ fontSize: '11.5px', fontWeight: 600, color: T.fg }}>Effort</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '11px', color: T.fgM }}>
                  <span style={{ color: T.ac, fontWeight: 700, textTransform: 'capitalize' }}>{eff}</span> · <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10px' }}>←/→</span> to adjust
                </span>
              </div>
              <div style={{ display: 'flex', border: `1px solid ${T.bd2}`, borderRadius: '8px', overflow: 'hidden', background: T.seg }}>
                {efforts.map((lv, i) => (
                  <div
                    key={lv}
                    onClick={() => setEffort(lv)}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '6px 4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                      color: lv === eff ? T.ac : T.fgM,
                      background: lv === eff ? T.acSoft : 'transparent',
                      borderLeft: i === 0 ? '1px solid transparent' : `1px solid ${T.bd2}`,
                    }}
                  >
                    {lv}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '8px', fontSize: '10.5px', color: T.fgF, lineHeight: 1.4 }}>
                Use <span style={{ fontFamily: 'Menlo, Consolas, monospace', color: T.mono }}>/fast</span> to turn on Fast mode (Opus 4.8).
              </div>
            </div>
          )}

          {/* FOOTER ACTIONS */}
          <div style={{ flex: '0 0 auto', padding: '11px 13px 12px', borderTop: `1px solid ${T.bd}`, background: T.hdr, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div
              onClick={() => commit('default')}
              onMouseEnter={() => setHover('btn:default')}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', background: hover === 'btn:default' ? T.acHover : T.ac, color: T.acT, fontWeight: 700, fontSize: '12.5px', borderRadius: '8px', padding: '8px 13px', cursor: 'pointer' }}
            >
              <i className='codicon codicon-check' style={{ fontSize: '14px' }} />
              Set as default
            </div>
            <div
              onClick={() => commit('session')}
              onMouseEnter={() => setHover('btn:session')}
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', border: `1px solid ${hover === 'btn:session' ? T.ac : T.bd2}`, color: hover === 'btn:session' ? T.ac : T.fg, fontWeight: 600, fontSize: '12px', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer', whiteSpace: 'nowrap', minWidth: 0 }}
            >
              <i className='codicon codicon-clock' style={{ fontSize: '13px', flex: '0 0 auto' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>This session only</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 11px', paddingTop: '2px', fontSize: '10px', color: T.fgF }}>
              <span><span style={{ color: T.fgM, fontWeight: 700 }}>↑↓</span> move</span>
              <span><span style={{ color: T.fgM, fontWeight: 700 }}>↵</span> set default</span>
              <span><span style={{ color: T.fgM, fontWeight: 700 }}>s</span> this session</span>
              <span><span style={{ color: T.fgM, fontWeight: 700 }}>Esc</span> cancel</span>
            </div>
          </div>
        </>
      )}

      {/* LOADING */}
      {status === 'loading' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '14px 13px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: T.fgM, fontSize: '12px', marginBottom: '16px' }}>
            <span style={{ width: '13px', height: '13px', border: `2px solid ${T.bd2}`, borderTopColor: T.ac, borderRadius: '50%', animation: 'spin .8s linear infinite', display: 'block' }} />
            Loading models…
          </div>
          {[{ w: '42%', w2: '72%' }, { w: '34%', w2: '64%' }, { w: '46%', w2: '78%' }, { w: '30%', w2: '58%' }, { w: '40%', w2: '70%' }].map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: '11px', marginBottom: '16px' }}>
              <div style={{ width: '17px', height: '17px', borderRadius: '50%', flex: '0 0 17px', background: T.skel1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ height: '11px', width: s.w, borderRadius: '5px', background: `linear-gradient(90deg,${T.skel1},${T.skel2},${T.skel1})`, backgroundSize: '260px 100%', animation: 'mp-shim 1.4s linear infinite' }} />
                <div style={{ height: '9px', width: s.w2, marginTop: '8px', borderRadius: '5px', background: `linear-gradient(90deg,${T.skel1},${T.skel2},${T.skel1})`, backgroundSize: '260px 100%', animation: 'mp-shim 1.4s linear infinite' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* EMPTY */}
      {status === 'empty' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '30px', textAlign: 'center' }}>
          <i className='codicon codicon-layers' style={{ fontSize: '36px', color: T.fgF }} />
          <div style={{ fontSize: '14px', fontWeight: 600, color: T.fg }}>No models available</div>
          <div style={{ fontSize: '12px', color: T.fgM, maxWidth: '230px', lineHeight: 1.5 }}>This account has no selectable models. Refresh the catalog or check your plan.</div>
          <div onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '2px', border: `1px solid ${T.bd2}`, color: T.fg, fontWeight: 600, fontSize: '12px', borderRadius: '8px', padding: '7px 14px', cursor: 'pointer' }}>
            <i className='codicon codicon-refresh' />
            Refresh
          </div>
        </div>
      )}

      {/* ERROR */}
      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '30px', textAlign: 'center' }}>
          <i className='codicon codicon-error' style={{ fontSize: '36px', color: T.err }} />
          <div style={{ fontSize: '14px', fontWeight: 600, color: T.fg }}>Couldn't load models</div>
          <div style={{ fontSize: '12px', color: T.fgM, maxWidth: '240px', lineHeight: 1.5 }}>The model catalog request failed. Check your connection and try again.</div>
          {error && <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10.5px', color: T.fgF, background: T.card, border: `1px solid ${T.bd}`, borderRadius: '6px', padding: '5px 9px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</div>}
          <div onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '2px', background: T.ac, color: T.acT, fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 15px', cursor: 'pointer' }}>
            <i className='codicon codicon-refresh' />
            Retry
          </div>
        </div>
      )}
    </div>
  )
}
