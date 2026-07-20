import { useState } from 'react'
import type { ChatToolUseBlock } from '../../chat/types.js'
import { Message } from './Message.js'
import { StatusIcon } from './ToolCard.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * A sub-agent (`Agent` / `Task`) call, rendered as a collapsible violet-accented
 * card. The header shows the sub-agent kind, its step count and lifecycle; when
 * expanded it renders the sub-agent's own transcript (`block.steps`, using the
 * same `Message` components as the main chat) followed by the returned Report
 * (`block.result`). Colors mirror the `Sub-Agents in Chat` design.
 */
export function SubAgentCard({ block }: { block: ChatToolUseBlock }) {
  const [open, setOpen] = useState(false)
  const input = (block.input ?? {}) as Record<string, unknown>
  const agentType = block.agentType ?? str(input.subagent_type)
  const description = str(input.description) ?? str(input.prompt)
  const steps = block.steps ?? []
  const running = block.status === 'pending' || block.status === 'allowed'
  const stepLabel = running && steps.length === 0 ? 'running…' : steps.length === 1 ? '1 step' : `${steps.length} steps`
  const hasBody = steps.length > 0 || !!description || !!block.result

  return (
    <div
      className='my-1.5 overflow-hidden rounded-lg border'
      style={{ borderColor: '#34303f', background: '#1c1a22' }}
    >
      <button
        type='button'
        onClick={() => hasBody && setOpen((o) => !o)}
        className='flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]'
        style={{ background: '#241f2e', cursor: hasBody ? 'pointer' : 'default' }}
      >
        <span className='codicon codicon-organization shrink-0 text-[14px]' style={{ color: '#a78bcf' }} />
        <span className='font-semibold' style={{ color: '#cdbfe6' }}>
          Subagent
        </span>
        {agentType && (
          <span
            className='rounded px-1.5 py-0.5 font-mono text-[11px]'
            style={{ background: '#00000030', color: '#b8a9d6' }}
          >
            {agentType}
          </span>
        )}
        <span style={{ color: '#8b8b8b' }}>{stepLabel}</span>
        <span className='flex-1' />
        {running ? (
          <span className='codicon codicon-loading codicon-modifier-spin text-[13px]' style={{ color: '#a78bcf' }} />
        ) : (
          <StatusIcon status={block.status} />
        )}
        {hasBody && (
          <span className='shrink-0 text-[9px]' style={{ color: '#8b8b8b' }}>
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>

      {open && hasBody && (
        <div className='flex flex-col gap-2 px-2.5 py-2.5' style={{ borderTop: '1px solid #34303f' }}>
          {description && (
            <div className='text-[11px] italic' style={{ color: '#8b8b8b' }}>
              {description}
            </div>
          )}
          {steps.length > 0 && (
            <div className='min-w-0'>
              {steps.map((m) => (
                <Message key={m.id} message={m} />
              ))}
            </div>
          )}
          {block.result && (
            <div
              className='rounded-r-md px-2.5 py-2 text-[12px]'
              style={{ borderLeft: '3px solid #89d185', background: '#18201a', color: '#c6d8c6' }}
            >
              <span className='font-semibold' style={{ color: '#a6e3a1' }}>
                Report
              </span>
              <span> — </span>
              <span className='whitespace-pre-wrap'>{block.result}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
