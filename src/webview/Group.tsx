import { useEffect, useState } from 'react'
import type { SessionGroup } from '../types.js'
import { Row } from './Row.js'

const COLLAPSED_LIMIT = 5

export function Group({
  group,
  now,
  open,
  searching,
  isPinned,
  onToggle,
  onNewSession,
  selectedId,
  debug,
  onSelect,
  onPin,
  onRename,
  onDelete,
  onDeleteReady,
  onReorder,
}: {
  group: SessionGroup
  now: number
  open: boolean
  /** A search query is active: show every (already-filtered) session flat. */
  searching: boolean
  /** Top-level "Pinned" section: show a pin glyph and hide the new-session "+". */
  isPinned?: boolean
  onToggle: (name: string, open: boolean) => void
  onNewSession: (path: string) => void
  selectedId: string | null
  /** Show per-row debug tooltips (id / live id / pid). */
  debug: boolean
  onSelect: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onDeleteReady: (ids: string[]) => void
  /** New order (session ids) for this section's active list, after a drag. */
  onReorder: (ids: string[]) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after' | null>(null)

  const active = group.sessions
  const readyIds = active.filter((s) => s.status === 'ready' && !s.pinned).map((s) => s.id)
  const hidden = active.length - COLLAPSED_LIMIT
  const visible = showAll ? active : active.slice(0, COLLAPSED_LIMIT)

  // A host-driven selection (a notification's "Open") can land on a row that
  // "+N more" is hiding. Expand rather than leave the highlight off-list.
  // `findIndex` is -1 when this group doesn't hold the selection, so groups
  // that aren't involved never expand.
  const selectionHidden = !showAll && active.findIndex((s) => s.id === selectedId) >= COLLAPSED_LIMIT
  useEffect(() => {
    if (selectionHidden) {
      setShowAll(true)
    }
  }, [selectionHidden])

  const handleRowDragStart = (id: string) => setDraggedId(id)

  const handleRowDragOver = (id: string, pos: 'before' | 'after') => {
    if (id === draggedId) {
      return
    }
    setDragOverId(id)
    setDragOverPos(pos)
  }

  const handleRowDrop = () => {
    if (draggedId && dragOverId && draggedId !== dragOverId) {
      const from = active.findIndex((s) => s.id === draggedId)
      const to = active.findIndex((s) => s.id === dragOverId)
      if (from !== -1 && to !== -1) {
        const reordered = [...active]
        const [moved] = reordered.splice(from, 1)
        const insertAt = reordered.findIndex((s) => s.id === dragOverId) + (dragOverPos === 'after' ? 1 : 0)
        reordered.splice(insertAt, 0, moved)
        onReorder(reordered.map((s) => s.id))
      }
    }
    setDraggedId(null)
    setDragOverId(null)
    setDragOverPos(null)
  }

  const handleRowDragEnd = () => {
    setDraggedId(null)
    setDragOverId(null)
    setDragOverPos(null)
  }

  const renderRow = (item: SessionGroup['sessions'][number]) => (
    <Row
      key={item.id}
      item={item}
      now={now}
      selected={item.id === selectedId}
      debug={debug}
      draggable={!searching}
      dragOver={item.id === dragOverId ? dragOverPos : null}
      onSelect={onSelect}
      onPin={onPin}
      onRename={onRename}
      onDelete={onDelete}
      onRowDragStart={handleRowDragStart}
      onRowDragOver={handleRowDragOver}
      onRowDrop={handleRowDrop}
      onRowDragEnd={handleRowDragEnd}
    />
  )

  return (
    <details className='mb-1' open={open} onToggle={(e) => onToggle(group.name, e.currentTarget.open)}>
      <summary className='flex items-center gap-1.5 cursor-pointer py-1.5 pl-1.5 pr-2 text-vs-fg'>
        <span
          className={`codicon codicon-triangle-down text-sm text-vs-desc transition-transform ${open ? '' : '-rotate-90'}`}
        />
        {isPinned && <span className='codicon codicon-pinned text-xs text-vs-desc' aria-hidden />}
        <span className='flex-1 min-w-0 truncate text-xs font-bold tracking-wide' title={group.name}>
          {group.name}
        </span>
        {!isPinned && (
          <span className='flex items-center gap-3'>
            <span
              className='codicon codicon-add text-sm text-vs-desc cursor-pointer rounded p-0.5 hover:text-vs-fg hover:bg-vs-hover-bg'
              title='New session in workspace'
              role='button'
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onNewSession(group.path)
              }}
            />
            {readyIds.length > 0 && (
              <span
                className='codicon codicon-trash text-sm text-vs-desc cursor-pointer rounded p-0.5 hover:text-vs-red hover:bg-vs-hover-bg'
                title={`Delete ${readyIds.length} ready session${readyIds.length > 1 ? 's' : ''}`}
                role='button'
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onDeleteReady(readyIds)
                }}
              />
            )}
          </span>
        )}
      </summary>
      {group.sessions.length ? (
        // While searching, `group.sessions` is already the match set — show it
        // flat, bypassing the collapse limit.
        searching ? (
          <ul className='list-none m-0 p-0'>{group.sessions.map(renderRow)}</ul>
        ) : (
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
          </ul>
        )
      ) : (
        <div className='pt-0.5 pb-2 pl-6 text-xs text-vs-desc'>No sessions yet.</div>
      )}
    </details>
  )
}
