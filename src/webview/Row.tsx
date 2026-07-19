import { useRef, useState } from 'react'
import type { SessionItem } from '../types.js'
import { relativeTime } from '../format.js'
import { STATUS_COLOR, STATUS_ICON, STATUS_LABEL, STATUS_TEXT } from './status.js'

export function Row({
  item,
  now,
  selected,
  debug,
  onSelect,
  onPin,
  onRename,
  onMarkDone,
}: {
  item: SessionItem
  now: number
  selected: boolean
  /** Show a debug tooltip with the row's id / live id / pid on hover. */
  debug: boolean
  onSelect: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onRename: (id: string, name: string) => void
  onMarkDone: (id: string, done: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Escape blurs the input but must not save; a normal blur (or Enter) saves.
  const skipCommit = useRef(false)
  // Debug tooltip anchor. Tracking a whole-row hover (rather than the native
  // `title`) makes the id/live/pid appear immediately on hovering anywhere on
  // the row — the native tooltip only showed in the gaps between child elements
  // that carry their own `title`, and only after the browser's ~1s delay.
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)

  const spin = item.status === 'working' ? ' codicon-modifier-spin' : ''
  // On the accent selection background the muted desc/fg colors lose contrast,
  // so selected rows switch their text to the selection foreground.
  const titleColor = selected ? 'text-vs-sel-fg' : 'text-vs-fg'
  const subColor = selected ? 'text-vs-sel-fg opacity-80' : 'text-vs-desc'
  const iconBase = selected ? 'text-vs-sel-fg' : 'text-vs-desc'
  // Shared chrome for the hover action buttons: a fixed square, flex-centered so
  // each glyph (codicon or inline SVG) sits on the same axis regardless of the
  // glyph's own font metrics. Codicon buttons append `codicon codicon-<name>`.
  const actionBtn = `flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer text-sm leading-none ${iconBase} hover:text-vs-fg hover:bg-vs-hover-bg`

  const displayName = item.customName ?? item.title

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(displayName)
    setEditing(true)
  }

  const finishEdit = () => {
    setEditing(false)
    if (skipCommit.current) {
      skipCommit.current = false
      return
    }
    const value = draft.trim()
    // Empty clears the custom name back to the derived title.
    if (value !== displayName) {
      onRename(item.id, value)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      skipCommit.current = true
      e.currentTarget.blur()
    }
  }

  // While debug mode is on the custom whole-row tooltip owns the hover, so
  // suppress the native child `title`s that would otherwise pop over it.
  const nativeTitle = (s: string | undefined) => (debug ? undefined : s)

  return (
    <li
      className={`group flex gap-2 rounded-md mb-0.5 py-2 pr-2 pl-2.5 cursor-pointer ${item.done ? 'opacity-60' : ''} ${selected ? 'bg-vs-sel-bg' : 'hover:bg-vs-hover-bg'}`}
      onMouseEnter={debug ? (e) => setTip({ x: e.clientX, y: e.clientY }) : undefined}
      onMouseLeave={debug ? () => setTip(null) : undefined}
      onClick={() => {
        if (!editing) {
          onSelect(item.id)
        }
      }}
    >
      <div className='w-4 shrink-0 flex justify-center items-start pt-0.5'>
        <span
          className={`codicon codicon-${STATUS_ICON[item.status]}${spin} text-sm leading-none ${STATUS_COLOR[item.status]}`}
          title={nativeTitle(STATUS_LABEL[item.status])}
        />
      </div>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-1.5'>
          {editing ? (
            <input
              className='flex-1 min-w-0 text-xs rounded px-1 py-0.5 outline-none bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-(--vscode-focusBorder,var(--vscode-input-border))'
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={finishEdit}
            />
          ) : (
            <>
              {item.pinned && (
                <span className={`codicon codicon-pinned shrink-0 text-xs ${subColor}`} title={nativeTitle('Pinned')} aria-hidden />
              )}
              <span
                className={`flex-1 min-w-0 truncate text-xs font-semibold ${titleColor} ${item.done ? 'line-through' : ''}`}
                title={nativeTitle(displayName)}
              >
                {displayName}
              </span>
              <div className='flex invisible group-hover:visible items-center gap-0.5 shrink-0'>
                <span
                  className={actionBtn}
                  title={nativeTitle(item.pinned ? 'Unpin' : 'Pin')}
                  role='button'
                  onClick={(e) => {
                    e.stopPropagation()
                    onPin(item.id, !item.pinned)
                  }}
                >
                  {item.pinned ? (
                    <svg
                      xmlns='http://www.w3.org/2000/svg'
                      width='14'
                      height='14'
                      viewBox='0 0 16 16'
                      fill='currentColor'
                      className='shrink-0'
                    >
                      <path d='M9.56016 10.2673L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L5.73223 6.43934L5.6526 6.58876L2.8419 7.52566C2.6775 7.58046 2.5532 7.71648 2.51339 7.88513C2.47357 8.05378 2.52392 8.23102 2.64646 8.35356L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5264 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L9.56016 10.2673ZM8.82138 9.52849L8.76403 9.5592C8.65137 9.61951 8.56608 9.72066 8.52567 9.84189L7.7815 12.0744L3.92562 8.21851L6.15812 7.47435C6.27966 7.43383 6.38101 7.34822 6.44126 7.23516L6.47143 7.17854L8.82138 9.52849ZM12.7178 7.4426L10.6636 8.54227L11.4024 9.28105L13.1897 8.32422C14.0759 7.84981 14.2538 6.65509 13.5443 5.94304L10.0589 2.44509C9.34701 1.73062 8.14697 1.90828 7.67261 2.79838L6.71556 4.59421L7.45476 5.33341L8.55511 3.26869C8.71323 2.97199 9.11324 2.91277 9.35055 3.15093L12.836 6.64888C13.0725 6.88623 13.0131 7.28446 12.7178 7.4426Z' />
                    </svg>
                  ) : (
                    <span className='codicon codicon-pin translate-y-px' />
                  )}
                </span>
                <span className={actionBtn} title={nativeTitle('Rename')} role='button' onClick={startEdit}>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='12'
                    height='12'
                    viewBox='0 0 12 12'
                    fill='currentColor'
                    className='shrink-0'
                  >
                    <path
                      fillRule='evenodd'
                      clipRule='evenodd'
                      d='M9.62999 0C10.9399 9.73611e-05 12.0098 1.07 12.0099 2.37988C12.0099 3.00987 11.7594 3.60957 11.3194 4.05957L10.6896 4.67969L4.50988 10.8604C4.2899 11.0803 3.99948 11.2396 3.68956 11.3096L0.620227 11.9902C0.620227 11.9902 0.549888 12 0.509876 12H0.50011C0.37011 12 0.239524 11.9496 0.149524 11.8496C0.0297368 11.7296 -0.0203258 11.5595 0.0196415 11.3896L0.699329 8.32031C0.769311 8.01039 0.919624 7.72997 1.14952 7.5L7.94933 0.700195C8.39933 0.250195 8.99999 0 9.62999 0ZM1.83995 8.20996C1.74995 8.29996 1.69027 8.41004 1.66027 8.54004L1.14952 10.8398L3.44933 10.3301C3.56914 10.3001 3.68946 10.2402 3.77941 10.1504L9.60949 4.32031L7.67003 2.37988L1.83995 8.20996ZM9.62023 1C9.25023 1 8.90952 1.14039 8.64952 1.40039L8.38488 1.66504L10.3341 3.61426L10.5997 3.34961C10.8596 3.08962 11.0001 2.73981 11.0001 2.37988C11 1.62007 10.38 1.00022 9.62023 1Z'
                    />
                  </svg>
                </span>
                <span
                  className={`${actionBtn} codicon codicon-check`}
                  title={nativeTitle(item.done ? 'Restore' : 'Mark done')}
                  role='button'
                  onClick={(e) => {
                    e.stopPropagation()
                    onMarkDone(item.id, !item.done)
                  }}
                />
              </div>
            </>
          )}
        </div>
        <div className={`mt-0.5 flex items-center gap-1.5 text-xs ${subColor}`}>
          <span className='shrink-0 whitespace-nowrap'>{STATUS_TEXT[item.status]}</span>•
          <span className='shrink-0 whitespace-nowrap'>{relativeTime(now - item.mtime)}</span>
        </div>
        {item.folder && (
          <div className={`mt-0.5 flex items-center gap-1 text-xs ${subColor}`} title={nativeTitle(item.folder)}>
            <span className='codicon codicon-folder shrink-0 text-xs! leading-none' aria-hidden />
            <span className='min-w-0 truncate'>{item.folder}</span>
          </div>
        )}
        {item.activity && <div className={`mt-1.5 truncate text-xs ${subColor}`}>{item.activity}</div>}
      </div>
      {debug && tip && (
        <div
          className='fixed z-50 pointer-events-none max-w-[240px] whitespace-pre-wrap break-all rounded border px-2 py-1 text-xs leading-relaxed shadow-lg bg-vs-tip-bg text-vs-tip-fg border-vs-tip-border'
          style={{
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            left: Math.max(8, Math.min(tip.x + 12, window.innerWidth - 248)),
            top: Math.min(tip.y + 12, window.innerHeight - 96),
          }}
        >
          {`id: ${item.id}\nlive: ${item.liveId ?? '—'}\npid: ${item.pid ?? '—'}\nstatus: ${item.status}`}
        </div>
      )}
    </li>
  )
}
