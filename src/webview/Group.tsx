import type { SessionGroup } from '../types.js'
import { Row } from './Row.js'

export function Group({
  group,
  now,
  open,
  onToggle,
}: {
  group: SessionGroup
  now: number
  open: boolean
  onToggle: (name: string, open: boolean) => void
}) {
  return (
    <details className='mb-1' open={open} onToggle={(e) => onToggle(group.name, e.currentTarget.open)}>
      <summary className='flex items-center gap-1.5 cursor-pointer py-1.5 pl-1.5 pr-2 text-vs-fg'>
        <span
          className={`codicon codicon-triangle-down text-sm text-vs-desc transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className='flex-1 min-w-0 truncate font-bold tracking-wide' title={group.name}>
          {group.name}
        </span>
        <span className='flex items-center gap-3'>
          <span className='codicon codicon-add text-sm text-vs-desc' title='New session in workspace' />
        </span>
      </summary>
      {group.sessions.length ? (
        <ul className='list-none m-0 p-0'>
          {group.sessions.map((item) => (
            <Row key={item.id} item={item} now={now} />
          ))}
        </ul>
      ) : (
        <div className='pt-0.5 pb-2 pl-6 text-xs text-vs-desc'>No sessions yet.</div>
      )}
    </details>
  )
}
