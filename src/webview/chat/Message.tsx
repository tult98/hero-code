import type { ChatMessage } from '../../chat/types.js'
import { ToolCard } from './ToolCard.js'

/** Render assistant text with light support for ``` fenced code blocks. */
function Text({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return (
    <div className='text-sm leading-relaxed text-vs-fg'>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const body = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
          return (
            <pre key={i} className='my-1.5 overflow-auto rounded bg-(--vscode-textCodeBlock-background) px-2.5 py-2 text-[12px] whitespace-pre'>
              {body}
            </pre>
          )
        }
        return (
          <span key={i} className='whitespace-pre-wrap'>
            {part}
          </span>
        )
      })}
    </div>
  )
}

/** One turn in the conversation: a user prompt or an assistant response. */
export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`mb-3 ${isUser ? 'flex justify-end' : ''}`}>
      <div className={isUser ? 'max-w-[85%] rounded-lg px-3 py-2 bg-vs-sel-bg text-vs-sel-fg' : 'w-full'}>
        {message.blocks.map((block, i) =>
          block.type === 'text' ? (
            isUser ? (
              <div key={i} className='text-sm whitespace-pre-wrap'>
                {block.text}
              </div>
            ) : (
              <Text key={i} text={block.text} />
            )
          ) : (
            <ToolCard key={block.id ?? i} block={block} />
          ),
        )}
      </div>
    </div>
  )
}
