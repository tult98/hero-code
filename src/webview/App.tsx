import { useEffect, useState } from 'react'
import type { SessionGroup } from '../types.js'
import { vscode } from './vscode-api.js'
import { Group } from './Group.js'

interface StateMessage {
  type: 'state'
  groups: SessionGroup[]
  /** When present, select this session id (used right after starting one). */
  selectId?: string
}

export function App() {
  const persisted = vscode.getState()
  const [groups, setGroups] = useState<SessionGroup[]>(persisted?.groups ?? [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(persisted?.collapsed ?? []))
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null)
  // Reference time for relative timestamps; refreshed each time data arrives.
  const [now, setNow] = useState(() => Date.now())
  // Live filter query. Transient by design — not persisted to vscode state, so a
  // reopened/reloaded panel never restores a stale filter.
  const [search, setSearch] = useState('')

  useEffect(() => {
    const onMessage = (event: MessageEvent<StateMessage>) => {
      if (event.data?.type === 'state') {
        setGroups(event.data.groups)
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
    vscode.setState({ groups, collapsed: [...collapsed], selectedId })
  }, [groups, collapsed, selectedId])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    const session = groups.flatMap((g) => g.sessions).find((s) => s.id === id)
    vscode.postMessage({ type: 'open', id, title: session?.title, liveId: session?.liveId })
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

  // Filter sessions by name + activity. When active, drop empty groups; groups
  // are force-opened below and Group renders matches flat (no collapse limit).
  const q = search.trim().toLowerCase()
  const searching = q.length > 0
  const filteredGroups = searching
    ? groups
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter(
            (s) =>
              (s.customName ?? s.title).toLowerCase().includes(q) ||
              (s.activity ?? '').toLowerCase().includes(q),
          ),
        }))
        .filter((group) => group.sessions.length > 0)
    : groups

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
              }
            }}
          />
        </div>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto pt-1 px-1.5 pb-2'>
        {filteredGroups.length ? (
          filteredGroups.map((group) => (
            <Group
              key={group.name}
              group={group}
              now={now}
              open={searching ? true : !collapsed.has(group.name)}
              searching={searching}
              onToggle={handleToggle}
              onNewSession={handleNewSession}
              selectedId={selectedId}
              onSelect={handleSelect}
              onPin={handlePin}
              onRename={handleRename}
              onMarkDone={handleMarkDone}
            />
          ))
        ) : searching ? (
          <div className='px-3 py-3 text-vs-desc'>No matching sessions.</div>
        ) : (
          <div className='px-3 py-3 text-vs-desc'>No workspace open.</div>
        )}
      </div>
    </div>
  )
}
