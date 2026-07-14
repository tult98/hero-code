import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock.js'

/**
 * Assistant markdown, styled with VS Code theme tokens. Fenced code is delegated
 * to {@link CodeBlock}; inline code renders as a subtle chip. GFM (tables,
 * task-lists, strikethrough) is enabled via remark-gfm.
 */
const components: Components = {
  h1: ({ children }) => <h1 className='mt-3 mb-1.5 text-[15px] font-bold text-vs-fg'>{children}</h1>,
  h2: ({ children }) => <h2 className='mt-3 mb-1.5 text-[14px] font-bold text-vs-fg'>{children}</h2>,
  h3: ({ children }) => <h3 className='mt-2.5 mb-1 text-[13px] font-bold text-vs-fg'>{children}</h3>,
  h4: ({ children }) => <h4 className='mt-2.5 mb-1 text-[13px] font-semibold text-vs-fg'>{children}</h4>,
  p: ({ children }) => <p className='my-1.5 first:mt-0 last:mb-0'>{children}</p>,
  ul: ({ children }) => <ul className='my-1.5 list-disc pl-5 flex flex-col gap-0.5'>{children}</ul>,
  ol: ({ children }) => <ol className='my-1.5 list-decimal pl-5 flex flex-col gap-0.5'>{children}</ol>,
  li: ({ children }) => <li className='marker:text-vs-desc'>{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target='_blank' rel='noreferrer' className='text-vs-accent hover:underline'>
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className='my-2 border-l-2 border-vs-accent pl-3 text-vs-desc'>{children}</blockquote>
  ),
  hr: () => <hr className='my-3 border-0 border-t border-(--vscode-panel-border,transparent)' />,
  strong: ({ children }) => <strong className='font-semibold text-vs-fg'>{children}</strong>,
  table: ({ children }) => (
    <div className='my-2 overflow-x-auto'>
      <table className='border-collapse text-[12px]'>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className='border border-(--vscode-panel-border,transparent) px-2 py-1 text-left font-semibold text-vs-fg'>{children}</th>
  ),
  td: ({ children }) => (
    <td className='border border-(--vscode-panel-border,transparent) px-2 py-1 align-top'>{children}</td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || '')
    const text = String(children)
    if (match || text.includes('\n')) {
      return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, '')} />
    }
    return (
      <code className='rounded bg-(--vscode-textCodeBlock-background) px-1.5 py-0.5 font-mono text-[12px]'>{children}</code>
    )
  },
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className='text-sm leading-relaxed text-vs-fg break-words'>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
