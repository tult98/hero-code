import type { SessionItem } from '../types.js'
import { relativeTime } from '../format.js'
import { STATUS_COLOR, STATUS_ICON, STATUS_LABEL } from './status.js'

export function Row({ item, now }: { item: SessionItem; now: number }) {
  const spin = item.status === 'working' ? ' codicon-modifier-spin' : ''

  return (
    <li className='flex gap-2 rounded-md mb-0.5 py-2 pr-2 pl-2.5'>
      <div className='w-4 shrink-0 flex justify-center pt-0.5'>
        <span
          className={`codicon codicon-${STATUS_ICON[item.status]}${spin} text-sm leading-none ${STATUS_COLOR[item.status]}`}
          title={STATUS_LABEL[item.status]}
        />
      </div>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-1.5'>
          <span className='flex-1 min-w-0 truncate text-sm font-semibold text-vs-fg' title={item.title}>
            {item.title}
          </span>
          <span className='shrink-0 whitespace-nowrap text-xs text-vs-desc'>
            {relativeTime(now - item.mtime)}
          </span>
        </div>
        {item.branch && (
          <div className='flex items-center gap-1 mt-0.5 text-xs text-vs-desc'>
            <span className='codicon codicon-git-branch shrink-0 text-xs' />
            <span className='truncate'>{item.branch}</span>
          </div>
        )}
        {item.activity && <div className='mt-1.5 truncate text-xs text-vs-desc'>{item.activity}</div>}
      </div>
    </li>
  )
}
