import { useEffect, useMemo, useRef, useState } from 'react'
import type { McpAction, McpServerInfo, McpStatus } from '../../chat/types.js'

/** Panel view driven by host's `mcpServers` message. */
export type McpPanelStatus = 'loading' | 'ready' | 'empty' | 'error'

interface McpPanelProps {
  status: McpPanelStatus
  servers: McpServerInfo[]
  error?: string
  /** Fire a live action on a server (enable/disable/reconnect/authenticate). */
  onAction: (name: string, action: McpAction) => void
  onRefresh: () => void
  onClose: () => void
}

/**
 * Theme tokens mapped onto VS Code CSS variables so the panel adapts to any
 * theme, with the pinned Claude accent (`#d97757`) kept across light/dark.
 * Mirrors the `t` object in the Claude Design `MCP Panel` source, extended with
 * the warn / error-soft / code tokens that panel uses.
 */
const T = {
  fg: 'var(--vscode-foreground)',
  fgM: 'var(--vscode-descriptionForeground)',
  fgF: 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
  hdr: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background))',
  panel: 'var(--vscode-editor-background)',
  bd: 'var(--vscode-panel-border, var(--vscode-widget-border))',
  bd2: 'var(--vscode-widget-border, var(--vscode-panel-border))',
  rowH: 'var(--vscode-list-hoverBackground)',
  card: 'var(--vscode-editorWidget-background)',
  codeBg: 'var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background))',
  ac: '#d97757',
  acHover: '#e0886a',
  acT: '#1a1a1a',
  acSoft: 'rgba(217,119,87,0.13)',
  acBd: 'rgba(217,119,87,0.38)',
  mono: '#d99b82',
  ok: '#89d185',
  err: '#f14c4c',
  errSoft: 'rgba(241,76,76,0.10)',
  errBd: 'rgba(241,76,76,0.32)',
  warn: '#e2b53d',
  warnSoft: 'rgba(226,181,61,0.09)',
  warnChip: 'rgba(226,181,61,0.20)',
  disabled: 'var(--vscode-descriptionForeground)',
  skel1: 'var(--vscode-editorWidget-background)',
  skel2: 'var(--vscode-list-hoverBackground)',
}

const chip: React.CSSProperties = {
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: '9.5px',
  fontWeight: 600,
  color: T.mono,
}

/** Scope grouping order in the list (Project → User → Claude.ai → Built-in → …). */
const SCOPE_ORDER = ['project', 'user', 'local', 'claudeai', 'managed', 'built-in', 'builtin']

interface StatusMeta {
  color: string
  label: string
  fill: string
  border: string
  anim: string
}

/** Dot colour / label / pulse for each MCP status. */
function statusMeta(status: McpStatus): StatusMeta {
  switch (status) {
    case 'connected':
      return { color: T.ok, label: 'connected', fill: T.ok, border: 'none', anim: 'none' }
    case 'failed':
      return { color: T.err, label: 'failed', fill: T.err, border: 'none', anim: 'none' }
    case 'needs-auth':
      return { color: T.warn, label: 'needs auth', fill: T.warn, border: 'none', anim: 'none' }
    case 'pending':
      return { color: T.ac, label: 'connecting…', fill: T.ac, border: 'none', anim: 'mcpulse 1.3s ease-in-out infinite' }
    case 'disabled':
      return { color: T.disabled, label: 'disabled', fill: 'transparent', border: `1.5px solid ${T.disabled}`, anim: 'none' }
    default:
      return { color: T.fgM, label: status, fill: T.fgM, border: 'none', anim: 'none' }
  }
}

function toolsLabel(count: number | null): string {
  if (count === null) {
    return 'discovering tools…'
  }
  return `${count} tool${count === 1 ? '' : 's'}`
}

function metaLine(s: McpServerInfo): string {
  switch (s.status) {
    case 'connected':
      return `· connected · ${toolsLabel(s.toolCount)}`
    case 'failed':
      return '· failed to start'
    case 'needs-auth':
      return `· needs auth · ${toolsLabel(s.toolCount)}`
    case 'pending':
      return '· connecting…'
    case 'disabled':
      return `· disabled · ${toolsLabel(s.toolCount)}`
    default:
      return `· ${s.status}`
  }
}

/** Detail-view action buttons for the current status. */
interface ActionDef {
  num: number
  label: string
  icon: string
  primary: boolean
  action?: McpAction
  spin?: boolean
}
function actionsFor(status: McpStatus): ActionDef[] {
  switch (status) {
    case 'disabled':
      return [{ num: 1, label: 'Enable', icon: 'codicon-play', primary: true, action: 'enable' }]
    case 'connected':
      return [
        { num: 1, label: 'Disable', icon: 'codicon-circle-slash', primary: true, action: 'disable' },
        { num: 2, label: 'Reconnect', icon: 'codicon-refresh', primary: false, action: 'reconnect' },
      ]
    case 'failed':
      return [
        { num: 1, label: 'Reconnect', icon: 'codicon-refresh', primary: true, action: 'reconnect' },
        { num: 2, label: 'Disable', icon: 'codicon-circle-slash', primary: false, action: 'disable' },
      ]
    case 'needs-auth':
      return [
        { num: 1, label: 'Authenticate', icon: 'codicon-key', primary: true, action: 'authenticate' },
        { num: 2, label: 'Disable', icon: 'codicon-circle-slash', primary: false, action: 'disable' },
      ]
    case 'pending':
      return [
        { num: 1, label: 'Connecting…', icon: 'codicon-loading', primary: true, spin: true },
        { num: 2, label: 'Disable', icon: 'codicon-circle-slash', primary: false, action: 'disable' },
      ]
    default:
      return []
  }
}

/** The Claude `/mcp` management panel — renders in the composer slot. */
export function McpPanel({ status, servers, error, onAction, onRefresh, onClose }: McpPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)

  // Grab focus on mount so keyboard nav works immediately.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // Grouped-by-scope view of the servers, plus a flat order for cursor nav.
  const groups = useMemo(() => {
    const byScope = new Map<string, McpServerInfo[]>()
    for (const s of servers) {
      const list = byScope.get(s.scope) ?? []
      list.push(s)
      byScope.set(s.scope, list)
    }
    const seen = new Set<string>()
    const ordered: { scope: string; label: string; path: string; rows: McpServerInfo[] }[] = []
    const push = (scope: string) => {
      if (seen.has(scope) || !byScope.has(scope)) {
        return
      }
      seen.add(scope)
      const rows = byScope.get(scope)!
      ordered.push({ scope, label: rows[0].scopeLabel, path: rows[0].scopePath, rows })
    }
    SCOPE_ORDER.forEach(push)
    for (const scope of byScope.keys()) {
      push(scope)
    }
    return ordered
  }, [servers])

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  const connectedCount = servers.filter((s) => s.status === 'connected').length
  const attentionCount = servers.filter((s) => s.status === 'failed' || s.status === 'needs-auth').length
  const subtitle = `${servers.length} server${servers.length === 1 ? '' : 's'} · ${connectedCount} connected${
    attentionCount ? ` · ${attentionCount} need attention` : ''
  }`

  // Errors-only diagnostics: failed servers (with error text) + needs-auth.
  const issues = useMemo(
    () =>
      servers
        .filter((s) => s.status === 'failed' || s.status === 'needs-auth')
        .map((s) => ({
          server: s.name,
          title: s.status === 'failed' ? 'Failed to start' : 'Needs authentication',
          msg: s.status === 'failed' ? s.error || 'The server process could not be started.' : 'This server requires authentication before its tools load.',
        })),
    [servers],
  )

  const selected = selectedName ? servers.find((s) => s.name === selectedName) : undefined

  const openServer = (name: string) => {
    setSelectedName(name)
    setToolsOpen(false)
    setView('detail')
  }
  const back = () => {
    if (view === 'detail') {
      setView('list')
    } else {
      onClose()
    }
  }

  const clampCursor = (c: number) => Math.max(0, Math.min(flat.length - 1, c))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      back()
      return
    }
    if (view === 'list') {
      if (!flat.length) {
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => clampCursor(c + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => clampCursor(c - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        openServer(flat[clampCursor(cursor)].name)
      } else if (e.key === ' ') {
        e.preventDefault()
        const s = flat[clampCursor(cursor)]
        onAction(s.name, s.status === 'disabled' ? 'enable' : 'disable')
      }
    } else if (view === 'detail' && selected) {
      const acts = actionsFor(selected.status)
      if (e.key === 'Enter' || e.key === '1') {
        e.preventDefault()
        if (acts[0]?.action) {
          onAction(selected.name, acts[0].action)
        }
      } else if (e.key === '2') {
        e.preventDefault()
        if (acts[1]?.action) {
          onAction(selected.name, acts[1].action)
        }
      }
    }
  }

  const iconBtn = (key: string): React.CSSProperties => ({
    fontSize: '14px',
    color: hover === key ? T.fg : T.fgM,
    background: hover === key ? T.rowH : 'transparent',
    cursor: 'pointer',
    padding: '2px',
    borderRadius: '5px',
    flex: '0 0 auto',
  })

  const headerTitle = view === 'detail' && selected ? selected.name : 'MCP servers'

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        border: `1px solid ${T.bd2}`,
        borderTop: `2px solid ${T.ac}`,
        borderRadius: '11px',
        background: T.panel,
        color: T.fg,
        outline: 'none',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontSize: '13px',
      }}
    >
      {/* HEADER */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px 8px 6px', borderBottom: `1px solid ${T.bd}`, background: T.hdr }}>
        <i
          className='codicon codicon-arrow-left'
          title='Back'
          onClick={back}
          onMouseEnter={() => setHover('back')}
          onMouseLeave={() => setHover(null)}
          style={{ ...iconBtn('back'), fontSize: '15px', padding: '3px' }}
        />
        <span style={{ fontSize: '13px', fontWeight: 600, color: T.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' }}>{headerTitle}</span>
        <span style={{ ...chip, background: T.acSoft, border: `1px solid ${T.acBd}`, borderRadius: '5px', padding: '1px 5px', flex: '0 0 auto' }}>/mcp</span>
        <span style={{ flex: 1, minWidth: 0 }} />
        {view === 'list' && status === 'ready' && (
          <i
            className='codicon codicon-refresh'
            title='Rescan servers'
            onClick={onRefresh}
            onMouseEnter={() => setHover('refresh')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('refresh')}
          />
        )}
        <i
          className='codicon codicon-close'
          title='Close (back to composer)'
          onClick={onClose}
          onMouseEnter={() => setHover('close')}
          onMouseLeave={() => setHover(null)}
          style={iconBtn('close')}
        />
      </div>

      {/* LIST */}
      {status === 'ready' && view === 'list' && (
        <>
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 12px 6px', borderBottom: `1px solid ${T.bd}`, fontSize: '11px', color: T.fgM }}>
            <span>{subtitle}</span>
          </div>

          {/* DIAGNOSTICS (errors-only) */}
          {issues.length > 0 && (
            <div style={{ flex: '0 0 auto', borderBottom: `1px solid ${T.bd}`, background: T.warnSoft, borderLeft: `2px solid ${T.warn}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 11px 5px' }}>
                <i className='codicon codicon-warning' style={{ fontSize: '13px', color: T.warn, flex: '0 0 auto' }} />
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: T.fg }}>MCP diagnostics</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '10px', fontWeight: 600, color: T.warn, background: T.warnChip, borderRadius: '9px', padding: '1px 7px' }}>{issues.length}</span>
              </div>
              <div style={{ padding: '2px 11px 10px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {issues.map((d) => (
                  <div
                    key={d.server}
                    onClick={() => openServer(d.server)}
                    style={{ background: T.card, border: `1px solid ${T.bd2}`, borderRadius: '8px', padding: '8px 9px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '3px' }}>
                      <span style={{ fontSize: '11.5px', fontWeight: 600, color: T.fg }}>{d.title}</span>
                      <span style={{ fontSize: '10.5px', color: T.fgM }}>·</span>
                      <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10px', color: T.mono }}>{d.server}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: T.fgM, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{d.msg}</div>
                    <div style={{ marginTop: '6px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', color: T.ac }}>
                        <i className='codicon codicon-arrow-right' style={{ fontSize: '11px' }} />
                        Open server
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* GROUPED SERVER LIST */}
          <div className='mcp-scroll' style={{ flex: 1, minHeight: 0, maxHeight: '360px', overflowY: 'auto', overflowX: 'hidden', padding: '6px 6px 4px' }}>
            {groups.map((g) => (
              <div key={g.scope} style={{ marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', padding: '7px 8px 4px' }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: T.fgM, flex: '0 0 auto' }}>{g.label}</span>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: 'Menlo, Consolas, monospace', fontSize: '9.5px', color: T.fgF, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.path}</span>
                </div>
                {g.rows.map((s) => {
                  const idx = flat.indexOf(s)
                  const hi = idx === cursor
                  const m = statusMeta(s.status)
                  const dim = s.status === 'disabled'
                  const enabled = s.status !== 'disabled'
                  const rowBg = hi ? T.acSoft : hover === `row:${s.name}` ? T.rowH : 'transparent'
                  return (
                    <div
                      key={s.name}
                      ref={(el) => {
                        if (idx === cursor) {
                          el?.scrollIntoView({ block: 'nearest' })
                        }
                      }}
                      onClick={() => {
                        setCursor(idx)
                        openServer(s.name)
                      }}
                      onMouseEnter={() => setHover(`row:${s.name}`)}
                      onMouseLeave={() => setHover(null)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '9px',
                        padding: '7px 8px 7px 9px',
                        cursor: 'pointer',
                        borderRadius: '7px',
                        marginBottom: '1px',
                        borderLeft: `2px solid ${hi ? T.ac : 'transparent'}`,
                        background: rowBg,
                        boxShadow: hi ? `inset 0 0 0 1px ${T.acBd}` : 'none',
                        opacity: dim ? 0.72 : 1,
                      }}
                    >
                      <span style={{ width: '9px', height: '9px', flex: '0 0 9px', borderRadius: '50%', background: m.fill, border: m.border, animation: m.anim }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 600, color: dim ? T.fgM : T.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                        <div style={{ fontSize: '11px', marginTop: '1px', color: s.status === 'failed' ? T.err : s.status === 'needs-auth' ? T.warn : T.fgM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{metaLine(s)}</div>
                      </div>
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          onAction(s.name, enabled ? 'disable' : 'enable')
                        }}
                        title={enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                        style={{ width: '26px', height: '15px', flex: '0 0 26px', borderRadius: '8px', background: enabled ? T.ac : T.card, position: 'relative', cursor: 'pointer', border: `1px solid ${enabled ? T.ac : T.bd2}` }}
                      >
                        <span style={{ position: 'absolute', top: '1px', left: enabled ? '12px' : '2px', width: '11px', height: '11px', borderRadius: '50%', background: enabled ? T.acT : T.fgM, transition: 'left .12s' }} />
                      </div>
                      <i className='codicon codicon-chevron-right' style={{ fontSize: '14px', color: hi ? T.ac : T.fgF, flex: '0 0 auto' }} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* FOOTER HINTS */}
          <div style={{ flex: '0 0 auto', padding: '8px 12px 9px', borderTop: `1px solid ${T.bd}`, background: T.hdr, display: 'flex', flexWrap: 'wrap', gap: '3px 12px', fontSize: '9.5px', color: T.fgF }}>
            <span><span style={{ color: T.fgM, fontWeight: 700 }}>↑↓</span> move</span>
            <span><span style={{ color: T.fgM, fontWeight: 700 }}>↵</span> open</span>
            <span><span style={{ color: T.fgM, fontWeight: 700 }}>Space</span> toggle</span>
            <span><span style={{ color: T.fgM, fontWeight: 700 }}>Esc</span> back</span>
          </div>
        </>
      )}

      {/* DETAIL */}
      {status === 'ready' && view === 'detail' && selected && (
        <McpDetail server={selected} toolsOpen={toolsOpen} setToolsOpen={setToolsOpen} onAction={onAction} hover={hover} setHover={setHover} />
      )}

      {/* LOADING */}
      {status === 'loading' && (
        <div style={{ padding: '11px 11px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: T.fgM, fontSize: '11.5px', marginBottom: '13px' }}>
            <span style={{ width: '12px', height: '12px', border: `2px solid ${T.bd2}`, borderTopColor: T.ac, borderRadius: '50%', animation: 'spin .8s linear infinite', display: 'block' }} />
            Scanning MCP servers…
          </div>
          {[{ w: '40%', w2: '66%' }, { w: '52%', w2: '74%' }, { w: '34%', w2: '58%' }, { w: '46%', w2: '70%' }, { w: '38%', w2: '62%' }].map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '14px' }}>
              <div style={{ width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 9px', background: T.skel1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ height: '10px', width: s.w, borderRadius: '5px', background: `linear-gradient(90deg,${T.skel1},${T.skel2},${T.skel1})`, backgroundSize: '260px 100%', animation: 'mp-shim 1.4s linear infinite' }} />
                <div style={{ height: '8px', width: s.w2, marginTop: '7px', borderRadius: '5px', background: `linear-gradient(90deg,${T.skel1},${T.skel2},${T.skel1})`, backgroundSize: '260px 100%', animation: 'mp-shim 1.4s linear infinite' }} />
              </div>
              <div style={{ width: '26px', height: '15px', borderRadius: '8px', flex: '0 0 26px', background: T.skel1 }} />
            </div>
          ))}
        </div>
      )}

      {/* EMPTY */}
      {status === 'empty' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '9px', padding: '26px 24px', textAlign: 'center' }}>
          <i className='codicon codicon-plug' style={{ fontSize: '28px', color: T.fgF }} />
          <div style={{ fontSize: '13px', fontWeight: 600, color: T.fg }}>No MCP servers configured</div>
          <div style={{ fontSize: '11.5px', color: T.fgM, maxWidth: '240px', lineHeight: 1.5 }}>
            Add a server to <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10.5px', color: T.mono }}>.mcp.json</span> or run{' '}
            <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10.5px', color: T.mono }}>claude mcp add</span> to connect tools.
          </div>
          <a href='https://docs.claude.com/mcp' target='_blank' rel='noreferrer' style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '2px', fontSize: '11.5px', color: T.ac, textDecoration: 'none' }}>
            <i className='codicon codicon-book' />
            MCP setup docs
          </a>
        </div>
      )}

      {/* ERROR */}
      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '9px', padding: '26px 24px', textAlign: 'center' }}>
          <i className='codicon codicon-error' style={{ fontSize: '28px', color: T.err }} />
          <div style={{ fontSize: '13px', fontWeight: 600, color: T.fg }}>Couldn't load MCP servers</div>
          <div style={{ fontSize: '11.5px', color: T.fgM, maxWidth: '250px', lineHeight: 1.5 }}>Reading the MCP configuration failed. Check the config files and try again.</div>
          {error && <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10px', color: T.fgF, background: T.card, border: `1px solid ${T.bd}`, borderRadius: '6px', padding: '4px 9px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</div>}
          <div onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '1px', background: T.ac, color: T.acT, fontWeight: 700, fontSize: '11.5px', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer' }}>
            <i className='codicon codicon-refresh' />
            Retry
          </div>
        </div>
      )}
    </div>
  )
}

interface McpDetailProps {
  server: McpServerInfo
  toolsOpen: boolean
  setToolsOpen: (fn: (v: boolean) => boolean) => void
  onAction: (name: string, action: McpAction) => void
  hover: string | null
  setHover: (v: string | null) => void
}

function McpDetail({ server, toolsOpen, setToolsOpen, onAction, hover, setHover }: McpDetailProps) {
  const m = statusMeta(server.status)
  const endpointLabel = server.kind === 'cmd' ? 'Command' : server.kind === 'builtin' ? 'Provider' : 'URL'
  const shownTools = server.tools.slice(0, 6)
  const moreTools = server.tools.length - shownTools.length
  const hasTools = server.tools.length > 0
  const toolCountLabel = server.toolCount === null ? '…' : String(server.toolCount)
  const actions = actionsFor(server.status)

  return (
    <>
      <div className='mcp-scroll' style={{ flex: 1, minHeight: 0, maxHeight: '400px', overflowY: 'auto', overflowX: 'hidden' }}>
        {/* STATUS */}
        <div style={{ padding: '10px 12px 9px', borderBottom: `1px solid ${T.bd}` }}>
          <SectionLabel>Status</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '9px', height: '9px', flex: '0 0 9px', borderRadius: '50%', background: m.fill, border: m.border, animation: m.anim }} />
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: m.color }}>{m.label}</span>
            {server.version && <span style={{ fontSize: '11px', color: T.fgM }}>· {server.version}</span>}
          </div>
        </div>

        {/* ENDPOINT */}
        <div style={{ padding: '10px 12px 9px', borderBottom: `1px solid ${T.bd}` }}>
          <SectionLabel>{endpointLabel}</SectionLabel>
          <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '11px', color: T.fg, lineHeight: 1.5, wordBreak: 'break-all' }}>{server.endpoint}</div>
        </div>

        {/* CONFIG LOCATION */}
        {server.scopePath && (
          <div style={{ padding: '10px 12px 9px', borderBottom: `1px solid ${T.bd}` }}>
            <SectionLabel>Config location</SectionLabel>
            <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '11px', color: T.fgM, lineHeight: 1.5, wordBreak: 'break-all' }}>{server.scopePath}</div>
          </div>
        )}

        {/* ERROR */}
        {server.status === 'failed' && server.error && (
          <div style={{ padding: '10px 12px 9px', borderBottom: `1px solid ${T.bd}` }}>
            <SectionLabel color={T.err}>Error</SectionLabel>
            <div style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '10.5px', color: T.err, background: T.errSoft, border: `1px solid ${T.errBd}`, borderRadius: '7px', padding: '8px 10px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{server.error}</div>
          </div>
        )}

        {/* TOOLS */}
        <div style={{ padding: '10px 12px 11px' }}>
          <div onClick={() => hasTools && setToolsOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: hasTools ? 'pointer' : 'default', marginBottom: toolsOpen && hasTools ? '7px' : '0' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: T.fgM }}>Tools</span>
            <span style={{ fontSize: '10.5px', fontWeight: 600, color: T.fg, background: T.card, border: `1px solid ${T.bd2}`, borderRadius: '9px', padding: '0 7px' }}>{toolCountLabel}</span>
            <span style={{ flex: 1 }} />
            {hasTools && <i className={`codicon ${toolsOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} style={{ fontSize: '14px', color: T.fgM }} />}
          </div>
          {toolsOpen && hasTools && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {shownTools.map((tl) => {
                const chipInfo = tl.destructive
                  ? { label: 'destructive', color: T.err, bg: T.errSoft, bd: T.errBd }
                  : tl.readOnly
                  ? { label: 'read-only', color: T.fgM, bg: T.card, bd: T.bd2 }
                  : null
                return (
                  <div key={tl.name} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '4px 8px', borderRadius: '6px', background: T.card }}>
                    <i className='codicon codicon-tools' style={{ fontSize: '11px', color: T.fgF, flex: '0 0 auto' }} />
                    <span style={{ flex: 1, minWidth: 0, fontFamily: 'Menlo, Consolas, monospace', fontSize: '11px', color: T.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tl.name}</span>
                    {chipInfo && <span style={{ flex: '0 0 auto', fontSize: '9.5px', fontWeight: 600, color: chipInfo.color, background: chipInfo.bg, border: `1px solid ${chipInfo.bd}`, borderRadius: '5px', padding: '1px 6px' }}>{chipInfo.label}</span>}
                  </div>
                )
              })}
              {moreTools > 0 && <div style={{ fontSize: '10.5px', color: T.fgF, padding: '3px 8px 0' }}>+{moreTools} more tools</div>}
            </div>
          )}
        </div>
      </div>

      {/* ACTION FOOTER */}
      <div style={{ flex: '0 0 auto', padding: '9px 11px 10px', borderTop: `1px solid ${T.bd}`, background: T.hdr, display: 'flex', flexDirection: 'column', gap: '7px' }}>
        <div style={{ display: 'flex', gap: '7px' }}>
          {actions.map((a) => {
            const disabled = !a.action
            const key = `act:${a.num}`
            const hovered = hover === key && !disabled
            return (
              <div
                key={a.num}
                onClick={() => a.action && onAction(server.name, a.action)}
                onMouseEnter={() => setHover(key)}
                onMouseLeave={() => setHover(null)}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  fontWeight: a.primary ? 700 : 600,
                  fontSize: '12px',
                  borderRadius: '8px',
                  padding: '7px 10px',
                  cursor: disabled ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  background: a.primary ? (disabled ? T.card : hovered ? T.acHover : T.ac) : hovered ? T.rowH : 'transparent',
                  color: a.primary ? (disabled ? T.fgM : T.acT) : hovered ? T.ac : T.fg,
                  border: a.primary ? '1px solid transparent' : `1px solid ${hovered ? T.ac : T.bd2}`,
                  opacity: disabled ? 0.7 : 1,
                }}
              >
                <span style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: '9px', fontWeight: 700, background: a.primary ? 'rgba(0,0,0,0.18)' : T.card, color: a.primary ? (disabled ? T.fgM : T.acT) : T.fgM, borderRadius: '4px', padding: '0 4px', flex: '0 0 auto' }}>{a.num}</span>
                <i className={`codicon ${a.icon}`} style={{ fontSize: '13px', flex: '0 0 auto', animation: a.spin ? 'spin .8s linear infinite' : 'none' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.label}</span>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 12px', fontSize: '9.5px', color: T.fgF }}>
          <span><span style={{ color: T.fgM, fontWeight: 700 }}>1·2</span> select action</span>
          <span><span style={{ color: T.fgM, fontWeight: 700 }}>↵</span> primary</span>
          <span><span style={{ color: T.fgM, fontWeight: 700 }}>Esc</span> back</span>
        </div>
      </div>
    </>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }) {
  return <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: color ?? T.fgM, marginBottom: '5px' }}>{children}</div>
}
