import type { ChatMessage } from '../../chat/types.js'
import { Markdown } from './Markdown.js'
import { ToolCard } from './ToolCard.js'

/** One turn in the conversation: a user prompt or an assistant response. */
export function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className='mb-4 flex justify-end'>
        <div className='max-w-[85%] rounded-[12px_12px_4px_12px] border border-(--vscode-panel-border,transparent) bg-vs-sel-bg px-3 py-2 text-vs-sel-fg'>
          {message.blocks.map((block, i) =>
            block.type === 'text' ? (
              <div key={i} className='text-[13px] whitespace-pre-wrap break-words'>
                {block.text}
              </div>
            ) : (
              <ToolCard key={block.id ?? i} block={block} />
            ),
          )}
        </div>
      </div>
    )
  }

  return (
    <div className='mb-4 flex gap-2.5'>
      <span className='codicon codicon-claude mt-0.5 shrink-0 text-base text-vs-accent' />
      <div className='min-w-0 flex-1'>
        {message.blocks.map((block, i) =>
          block.type === 'text' ? (
            <Markdown key={i} text={block.text} />
          ) : (
            <ToolCard key={block.id ?? i} block={block} />
          ),
        )}
      </div>
    </div>
  )
}
