import { useState } from 'react'

/**
 * A fenced code block: a header (language label + copy button) over a scrollable
 * monospace body. Reused by the markdown renderer and by tool cards (Read / Bash /
 * Write result bodies). Kept theme-plain — no syntax highlighting.
 */
export function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1300)
    } catch {
      /* clipboard is unavailable in some webview sandboxes — ignore */
    }
  }

  return (
    <div className='my-2 overflow-hidden rounded-md border border-(--vscode-panel-border,transparent) bg-(--vscode-textCodeBlock-background)'>
      <div className='flex items-center gap-2 border-b border-(--vscode-panel-border,transparent) px-2.5 py-1 text-[11px] text-vs-desc'>
        <span className='font-mono'>{language || 'code'}</span>
        <span className='flex-1' />
        <span role='button' title='Copy' onClick={copy} className='flex items-center gap-1 cursor-pointer hover:text-vs-fg'>
          <span className={`codicon ${copied ? 'codicon-check text-vs-green' : 'codicon-copy'}`} />
          {copied ? 'Copied' : 'Copy'}
        </span>
      </div>
      <pre className='overflow-x-auto px-2.5 py-2 text-[12px] leading-relaxed'>
        <code className='font-mono whitespace-pre'>{code}</code>
      </pre>
    </div>
  )
}
