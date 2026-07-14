import { useEffect, useState } from 'react'
import type { SessionGroup, SessionItem, Status } from '../types.js'
import { vscode } from './vscode-api.js'
import { Group } from './Group.js'
import { StatusFilter } from './StatusFilter.js'

interface StateMessage {
  type: 'state'
  groups: SessionGroup[]
  /** When present, select this session id (used right after starting one). */
  selectId?: string
  /** Debug mode: show per-row id/live/pid tooltips. Driven by `heroCode.debugMode`. */
  debug?: boolean
}

export function App() {
  const persisted = vscode.getState()
  const [groups, setGroups] = useState<SessionGroup[]>(persisted?.groups ?? [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(persisted?.collapsed ?? []))
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null)
  // Debug tooltips (driven by the `heroCode.debugMode` setting, pushed by the host).
  const [debug, setDebug] = useState<boolean>(persisted?.debug ?? false)
  // Reference time for relative timestamps; refreshed each time data arrives.
  const [now, setNow] = useState(() => Date.now())
  // Live filter query. Transient by design — not persisted to vscode state, so a
  // reopened/reloaded panel never restores a stale filter.
  const [search, setSearch] = useState('')
  // Status filter (multi-select). Empty set = "All". Transient like `search`,
  // for the same reason: a reopened panel shouldn't restore a stale filter.
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set())

  useEffect(() => {
    const onMessage = (event: MessageEvent<StateMessage>) => {
      if (event.data?.type === 'state') {
        setGroups(event.data.groups)
        setDebug(!!event.data.debug)
        setNow(Date.now())
        // Host-driven selection (e.g. right after starting a new session). Set
        // it directly rather than via handleSelect — the host already opened
        // the terminal, so no `open` message is needed.
        if (event.data.selectId) {
          setSelectedId(event.data.selectId)
        }
      }
    }
    window.addEventListener('message', onMessage)
    // Signal readiness so the host posts the current state (also covers reloads).
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Persist data + collapse state so a webview reload restores instantly.
  useEffect(() => {
    vscode.setState({ groups, collapsed: [...collapsed], selectedId, debug })
  }, [groups, collapsed, selectedId, debug])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    const group = groups.find((g) => g.sessions.some((s) => s.id === id))
    const session = group?.sessions.find((s) => s.id === id)
    vscode.postMessage({
      type: 'open',
      id,
      title: session?.title,
      liveId: session?.liveId,
      path: group?.path,
      running: session?.running,
    })
  }

  const handleRefresh = () => vscode.postMessage({ type: 'refresh' })

  const handleNewSession = (path: string) => vscode.postMessage({ type: 'newSession', path })

  // Pin / rename / done are persisted host-side; the host re-posts authoritative
  // state, so these handlers only need to fire the message.
  const handlePin = (id: string, pinned: boolean) => vscode.postMessage({ type: 'pin', id, pinned })
  const handleRename = (id: string, name: string) => vscode.postMessage({ type: 'rename', id, name })
  const handleMarkDone = (id: string, done: boolean) => vscode.postMessage({ type: 'done', id, done })

  const handleToggle = (name: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (open) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const handleStatusToggle = (status: Status) =>
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })

  // Filter sessions by name + activity. When active, drop empty groups; groups
  // are force-opened below and Group renders matches flat (no collapse limit).
  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const matchesQuery = (s: SessionItem) =>
    !searching ||
    (s.customName ?? s.title).toLowerCase().includes(q) ||
    (s.activity ?? '').toLowerCase().includes(q)

  // Per-status counts within the search scope (the status filter itself is
  // ignored, so the chips show how many of each status are available to filter
  // to). `total` drives the "All" chip.
  const counts: Record<Status, number> = { working: 0, waiting: 0, idle: 0, error: 0 }
  for (const group of groups) {
    for (const s of group.sessions) {
      if (matchesQuery(s)) counts[s.status]++
    }
  }
  const totalCount = counts.working + counts.waiting + counts.idle + counts.error
  const hasSessions = groups.some((group) => group.sessions.length > 0)

  // Any filter active — text query or status chips. Everything downstream keys
  // off this: force-open, flat render, drop-empty groups, and the empty state.
  const filtering = searching || statusFilter.size > 0

  // Filter sessions by name + activity + status. When filtering, drop empty
  // groups; groups are force-opened below and Group renders matches flat.
  const filteredGroups = filtering
    ? groups
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter(
            (s) => matchesQuery(s) && (statusFilter.size === 0 || statusFilter.has(s.status)),
          ),
        }))
        .filter((group) => group.sessions.length > 0)
    : groups

  // Pinned sessions are lifted out of their folder into a single top-level
  // "Pinned" section above all folders. Newest-created first, held fixed so
  // rows never reorder as sessions work (they're all pinned, so that key is moot).
  const pinnedSessions = filteredGroups
    .flatMap((group) => group.sessions)
    .filter((s) => s.pinned)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  // Folder groups with their pinned rows removed. While searching, also drop
  // groups left empty so results stay tight (mirrors the filter above).
  const folderGroups = filteredGroups
    .map((group) => ({ ...group, sessions: group.sessions.filter((s) => !s.pinned) }))
    .filter((group) => !filtering || group.sessions.length > 0)

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='h-9 shrink-0 flex items-center justify-between pl-5 pr-2.5 text-xs tracking-wide text-vs-header'>
        <span>SESSIONS</span>
        <span className='flex items-center gap-3'>
          <span
            className='codicon codicon-refresh text-sm text-vs-desc cursor-pointer rounded p-0.5 hover:text-vs-fg hover:bg-vs-hover-bg'
            title='Refresh'
            role='button'
            onClick={handleRefresh}
          />
          <span className='codicon codicon-ellipsis text-sm text-vs-desc' title='More' />
        </span>
      </div>
      <div className='shrink-0 px-2.5 pt-1 pb-1.5'>
        <div className='relative'>
          <span className='codicon codicon-search absolute left-2 top-1/2 -translate-y-1/2 text-xs text-vs-desc pointer-events-none' />
          <input
            className='w-full text-xs rounded pl-7 pr-2 py-1 outline-none bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-(--vscode-input-border,transparent) focus:border-(--vscode-focusBorder) placeholder:text-vs-desc'
            placeholder='Search sessions...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setSearch('')
                setStatusFilter(new Set())
              }
            }}
          />
        </div>
      </div>
      {hasSessions && (
        <div className='shrink-0 px-2.5 pb-2'>
          <StatusFilter
            active={statusFilter}
            counts={counts}
            total={totalCount}
            onToggle={handleStatusToggle}
            onClear={() => setStatusFilter(new Set())}
          />
        </div>
      )}
      <div className='flex-1 min-h-0 overflow-y-auto pt-1 px-1.5 pb-2'>
        {pinnedSessions.length || folderGroups.length ? (
          <>
            {pinnedSessions.length > 0 && (
              <Group
                key='Pinned'
                group={{ name: 'Pinned', path: '', sessions: pinnedSessions }}
                now={now}
                open={filtering ? true : !collapsed.has('Pinned')}
                searching={filtering}
                isPinned
                onToggle={handleToggle}
                onNewSession={handleNewSession}
                selectedId={selectedId}
                debug={debug}
                onSelect={handleSelect}
                onPin={handlePin}
                onRename={handleRename}
                onMarkDone={handleMarkDone}
              />
            )}
            {folderGroups.map((group) => (
              <Group
                key={group.name}
                group={group}
                now={now}
                open={filtering ? true : !collapsed.has(group.name)}
                searching={filtering}
                onToggle={handleToggle}
                onNewSession={handleNewSession}
                selectedId={selectedId}
                debug={debug}
                onSelect={handleSelect}
                onPin={handlePin}
                onRename={handleRename}
                onMarkDone={handleMarkDone}
              />
            ))}
          </>
        ) : filtering ? (
          <div className='px-3 py-3 text-vs-desc'>No matching sessions.</div>
        ) : (
          <div className='px-3 py-3 text-vs-desc'>No workspace open.</div>
        )}
      </div>
    </div>
  )
}
