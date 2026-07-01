import type { SessionItem } from '../types.js'
import { relativeTime } from '../format.js'
import { STATUS_COLOR, STATUS_ICON, STATUS_LABEL } from './status.js'

export function Row({
  item,
  now,
  selected,
  onSelect,
}: {
  item: SessionItem
  now: number
  selected: boolean
  onSelect: (id: string) => void
}) {
  const spin = item.status === 'working' ? ' codicon-modifier-spin' : ''
  // On the accent selection background the muted desc/fg colors lose contrast,
  // so selected rows switch their text to the selection foreground.
  const titleColor = selected ? 'text-vs-sel-fg' : 'text-vs-fg'
  const subColor = selected ? 'text-vs-sel-fg opacity-80' : 'text-vs-desc'

  return (
    <li
      className={`flex gap-2 rounded-md mb-0.5 py-2 pr-2 pl-2.5 cursor-pointer ${selected ? 'bg-vs-sel-bg' : 'hover:bg-vs-hover-bg'}`}
      onClick={() => onSelect(item.id)}
    >
      <div className='w-4 shrink-0 flex justify-center items-start pt-0.5'>
        <span
          className={`codicon codicon-${STATUS_ICON[item.status]}${spin} text-sm leading-none ${STATUS_COLOR[item.status]}`}
          title={STATUS_LABEL[item.status]}
        />
      </div>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-1.5'>
          <span className={`flex-1 min-w-0 truncate text-xs font-semibold ${titleColor}`} title={item.title}>
            {item.title}
          </span>
          <span className={`shrink-0 whitespace-nowrap text-xs ${subColor}`}>{relativeTime(now - item.mtime)}</span>
        </div>
        {item.branch && (
          <div className={`flex items-center gap-1 mt-0.5 text-xs ${subColor}`}>
            <span className='codicon codicon-git-branch shrink-0 text-xs' />
            <span className='truncate'>{item.branch}</span>
          </div>
        )}
        {item.activity && <div className={`mt-1.5 truncate text-xs ${subColor}`}>{item.activity}</div>}
      </div>
    </li>
  )
}
