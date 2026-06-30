import { useEffect, useState } from 'react'
import type { SessionGroup } from '../types.js'
import { vscode } from './vscode-api.js'
import { Group } from './Group.js'

interface StateMessage {
  type: 'state'
  groups: SessionGroup[]
}

export function App() {
  const persisted = vscode.getState()
  const [groups, setGroups] = useState<SessionGroup[]>(persisted?.groups ?? [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(persisted?.collapsed ?? []))
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null)
  // Reference time for relative timestamps; refreshed each time data arrives.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const onMessage = (event: MessageEvent<StateMessage>) => {
      if (event.data?.type === 'state') {
        setGroups(event.data.groups)
        setNow(Date.now())
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

  const handleSelect = (id: string) => setSelectedId(id)

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

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='h-9 shrink-0 flex items-center justify-between pl-5 pr-2.5 text-xs tracking-wide text-vs-header'>
        <span>SESSIONS</span>
        <span className='flex items-center gap-3'>
          <span className='codicon codicon-refresh text-sm text-vs-desc' title='Refresh' />
          <span className='codicon codicon-ellipsis text-sm text-vs-desc' title='More' />
        </span>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto pt-1 px-1.5 pb-2'>
        {groups.length ? (
          groups.map((group) => (
            <Group
              key={group.name}
              group={group}
              now={now}
              open={!collapsed.has(group.name)}
              onToggle={handleToggle}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          ))
        ) : (
          <div className='px-3 py-3 text-vs-desc'>No workspace open.</div>
        )}
      </div>
    </div>
  )
}
