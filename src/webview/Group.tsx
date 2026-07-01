import { useState } from 'react'
import type { SessionGroup } from '../types.js'
import { Row } from './Row.js'

const COLLAPSED_LIMIT = 5

export function Group({
  group,
  now,
  open,
  onToggle,
  selectedId,
  onSelect,
  onPin,
  onRename,
  onMarkDone,
}: {
  group: SessionGroup
  now: number
  open: boolean
  onToggle: (name: string, open: boolean) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onRename: (id: string, name: string) => void
  onMarkDone: (id: string, done: boolean) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [showDone, setShowDone] = useState(false)

  // Done sessions are hidden from the active list and revealed on demand.
  const active = group.sessions.filter((s) => !s.done)
  const doneItems = group.sessions.filter((s) => s.done)
  const hidden = active.length - COLLAPSED_LIMIT
  const visible = showAll ? active : active.slice(0, COLLAPSED_LIMIT)

  const renderRow = (item: SessionGroup['sessions'][number]) => (
    <Row
      key={item.id}
      item={item}
      now={now}
      selected={item.id === selectedId}
      onSelect={onSelect}
      onPin={onPin}
      onRename={onRename}
      onMarkDone={onMarkDone}
    />
  )

  return (
    <details className='mb-1' open={open} onToggle={(e) => onToggle(group.name, e.currentTarget.open)}>
      <summary className='flex items-center gap-1.5 cursor-pointer py-1.5 pl-1.5 pr-2 text-vs-fg'>
        <span
          className={`codicon codicon-triangle-down text-sm text-vs-desc transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className='flex-1 min-w-0 truncate text-xs font-bold tracking-wide' title={group.name}>
          {group.name}
        </span>
        <span className='flex items-center gap-3'>
          <span className='codicon codicon-add text-sm text-vs-desc' title='New session in workspace' />
        </span>
      </summary>
      {group.sessions.length ? (
        <ul className='list-none m-0 p-0'>
          {visible.map(renderRow)}
          {hidden > 0 && (
            <li
              className='text-center text-xs text-vs-desc cursor-pointer rounded-md py-1.5 select-none hover:bg-vs-hover-bg'
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show less' : `+${hidden} more`}
            </li>
          )}
          {doneItems.length > 0 && (
            <li
              className='flex items-center justify-center gap-1.5 text-xs text-vs-desc cursor-pointer rounded-md py-1.5 select-none hover:bg-vs-hover-bg'
              onClick={() => setShowDone((v) => !v)}
            >
              <span className='codicon codicon-check-all text-xs' />
              {showDone ? 'Hide done' : `${doneItems.length} done`}
            </li>
          )}
          {showDone && doneItems.map(renderRow)}
        </ul>
      ) : (
        <div className='pt-0.5 pb-2 pl-6 text-xs text-vs-desc'>No sessions yet.</div>
      )}
    </details>
  )
}
