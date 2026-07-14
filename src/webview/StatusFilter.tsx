import type { Status } from '../types.js'
import { STATUS_COLOR, STATUS_LABEL } from './status.js'

// Chip order mirrors the approved mock: All, then activity-first statuses.
const STATUSES: Status[] = ['working', 'waiting', 'idle', 'error']

// The status color token, minus any animation utility (`waiting` carries
// `animate-scpulse` for the row indicator, but a filter dot shouldn't pulse).
const dotColor = (s: Status) => STATUS_COLOR[s].split(' ')[0]

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs cursor-pointer select-none whitespace-nowrap transition-colors'
const CHIP_ON = 'border-(--vscode-focusBorder) bg-vs-hover-bg text-vs-fg'
const CHIP_OFF =
  'border-(--vscode-input-border,transparent) text-vs-desc hover:bg-vs-hover-bg hover:text-vs-fg'

/**
 * Multi-select status filter shown under the search box. An empty `active` set
 * means "All" (no status constraint). Chips report per-status counts within the
 * current search scope; zero-count status chips are dimmed and inert.
 */
export function StatusFilter({
  active,
  counts,
  total,
  onToggle,
  onClear,
}: {
  active: Set<Status>
  counts: Record<Status, number>
  total: number
  onToggle: (status: Status) => void
  onClear: () => void
}) {
  const allActive = active.size === 0

  return (
    <div className='flex flex-wrap items-center gap-1'>
      <span
        className={`${CHIP_BASE} ${allActive ? CHIP_ON : CHIP_OFF}`}
        role='button'
        aria-pressed={allActive}
        title='Show all statuses'
        onClick={onClear}
      >
        <span>All</span>
        <span className='opacity-70 tabular-nums'>{total}</span>
      </span>
      {STATUSES.map((s) => {
        const count = counts[s]
        const on = active.has(s)
        const empty = count === 0
        return (
          <span
            key={s}
            className={`${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF} ${empty ? 'opacity-50 pointer-events-none' : ''}`}
            role='button'
            aria-pressed={on}
            aria-disabled={empty}
            title={`${on ? 'Hide' : 'Show'} ${STATUS_LABEL[s]}`}
            onClick={() => onToggle(s)}
          >
            <span className={`codicon codicon-circle-filled text-[8px] leading-none ${dotColor(s)}`} aria-hidden />
            <span>{STATUS_LABEL[s]}</span>
            <span className='opacity-70 tabular-nums'>{count}</span>
          </span>
        )
      })}
    </div>
  )
}
