import type { ChatToolUseBlock } from '../../chat/types.js'

const STATUS_ICON: Record<ChatToolUseBlock['status'], string> = {
  pending: 'question',
  allowed: 'loading codicon-modifier-spin',
  denied: 'circle-slash',
  done: 'check',
  error: 'error',
}

/** One tool call: a compact, presentational card. Approve/Deny lives in the
 *  permission banner above the input (see Chat.tsx). */
export function ToolCard({ block }: { block: ChatToolUseBlock }) {
  return (
    <div className='my-1.5 rounded border border-(--vscode-panel-border,transparent) bg-vs-hover-bg/40 text-xs'>
      <div className='flex items-center gap-2 px-2.5 py-1.5'>
        <span className={`codicon codicon-${STATUS_ICON[block.status]} text-vs-desc`} />
        <span className='font-medium text-vs-fg'>{block.name}</span>
        <span className='truncate text-vs-desc'>{block.label}</span>
      </div>
      {block.result && (
        <pre className='mx-2.5 mb-2 max-h-40 overflow-auto rounded bg-(--vscode-textCodeBlock-background) px-2 py-1 text-[11px] whitespace-pre-wrap text-vs-desc'>
          {block.result}
        </pre>
      )}
    </div>
  )
}
