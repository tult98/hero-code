import { useState } from 'react'
import type { ChatToolUseBlock } from '../../chat/types.js'
import { CodeBlock } from './CodeBlock.js'
import { DiffView, computeDiff } from './DiffView.js'
import { Markdown } from './Markdown.js'

/** Codicon per tool name (falls back to a generic wrench). */
const TOOL_ICON: Record<string, string> = {
  Read: 'file-code',
  Edit: 'diff-single',
  MultiEdit: 'diff-single',
  NotebookEdit: 'diff-single',
  Write: 'new-file',
  Bash: 'terminal',
  Grep: 'search',
  Glob: 'search',
  TodoWrite: 'checklist',
  Task: 'organization',
  WebFetch: 'globe',
  WebSearch: 'search',
  AskUserQuestion: 'comment-discussion',
  ExitPlanMode: 'checklist',
}

interface TodoItem {
  content: string
  status: string
}

/** Right-aligned lifecycle indicator. */
function StatusIcon({ status }: { status: ChatToolUseBlock['status'] }) {
  switch (status) {
    case 'allowed':
      return <span className='codicon codicon-loading codicon-modifier-spin text-[13px] text-vs-accent' />
    case 'done':
      return <span className='codicon codicon-check text-[13px] text-vs-green' />
    case 'error':
      return <span className='codicon codicon-error text-[13px] text-vs-red' />
    case 'denied':
      return <span className='codicon codicon-circle-slash text-[13px] text-vs-red' />
    default:
      return <span className='codicon codicon-question text-[13px] text-vs-desc' />
  }
}

function langFromPath(file?: string): string | undefined {
  if (!file) {
    return undefined
  }
  const ext = file.split('.').pop()
  return ext && ext !== file ? ext : undefined
}

/** One tool call: a collapsible card whose body is tailored to the tool. */
export function ToolCard({ block }: { block: ChatToolUseBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

  const isEdit = block.name === 'Edit' || block.name === 'NotebookEdit'
  const oldStr = str(input.old_string)
  const newStr = str(input.new_string)
  const hasDiff = isEdit && oldStr !== undefined && newStr !== undefined
  const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : undefined
  const isPlan = block.name === 'ExitPlanMode' && !!str(input.plan)

  // Does this card have anything to reveal?
  const hasBody = hasDiff || !!todos || isPlan || !!block.result || !!str(input.content) || block.name === 'Task'
  const defaultOpen = block.name === 'Bash' || isEdit || block.name === 'TodoWrite' || isPlan
  const [open, setOpen] = useState(defaultOpen)

  const isError = block.status === 'error'
  const detail = block.label.startsWith(`${block.name} · `) ? block.label.slice(block.name.length + 3) : block.label
  const diffCounts = hasDiff ? computeDiff(oldStr as string, newStr as string) : undefined

  return (
    <div
      className={`my-1.5 overflow-hidden rounded-lg border text-xs ${
        isError ? 'border-vs-red/40 bg-vs-red/5' : 'border-(--vscode-panel-border,transparent) bg-vs-hover-bg/40'
      }`}
    >
      <div
        className={`flex items-center gap-2 px-2.5 py-1.5 ${hasBody ? 'cursor-pointer' : ''}`}
        onClick={hasBody ? () => setOpen((v) => !v) : undefined}
      >
        <span className={`codicon codicon-${TOOL_ICON[block.name] ?? 'tools'} ${isError ? 'text-vs-red' : 'text-vs-accent'}`} />
        <span className={`font-semibold ${isError ? 'text-vs-red' : 'text-vs-fg'}`}>{block.name}</span>
        {detail && detail !== block.name && (
          <span className='min-w-0 truncate font-mono text-[11px] text-vs-desc'>{detail}</span>
        )}
        {diffCounts && (
          <span className='flex shrink-0 items-center gap-1.5 font-mono text-[11px]'>
            <span className='text-vs-green'>+{diffCounts.added}</span>
            <span className='text-vs-red'>−{diffCounts.removed}</span>
          </span>
        )}
        <span className='flex-1' />
        <StatusIcon status={block.status} />
        {hasBody && (
          <span className={`codicon codicon-chevron-down text-[13px] text-vs-desc transition-transform ${open ? '' : '-rotate-90'}`} />
        )}
      </div>

      {open && hasBody && (
        <div className='border-t border-(--vscode-panel-border,transparent)'>
          {hasDiff ? (
            <div className='py-1.5'>
              <DiffView oldStr={oldStr as string} newStr={newStr as string} />
            </div>
          ) : todos ? (
            <TodoList todos={todos} />
          ) : block.name === 'Write' && str(input.content) ? (
            <div className='px-2 pb-2'>
              <CodeBlock language={langFromPath(str(input.file_path))} code={str(input.content) as string} />
            </div>
          ) : block.name === 'Read' && block.result ? (
            <div className='px-2 pb-2'>
              <CodeBlock language={langFromPath(str(input.file_path))} code={block.result} />
            </div>
          ) : isPlan ? (
            <div className='px-3 py-2'>
              <Markdown text={str(input.plan) as string} />
            </div>
          ) : block.name === 'Task' ? (
            <TaskBody input={input} result={block.result} />
          ) : block.result ? (
            <pre
              className={`max-h-52 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] ${
                isError ? 'text-vs-red' : 'text-vs-desc'
              }`}
            >
              {block.result}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  )
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className='flex flex-col gap-1.5 px-3 py-2 text-[12.5px]'>
      {todos.map((t, i) => {
        const done = t.status === 'completed'
        const active = t.status === 'in_progress'
        return (
          <div key={i} className='flex items-center gap-2'>
            {done ? (
              <span className='codicon codicon-pass-filled text-[14px] text-vs-green' />
            ) : active ? (
              <span className='codicon codicon-loading codicon-modifier-spin text-[14px] text-vs-accent' />
            ) : (
              <span className='codicon codicon-circle-large-outline text-[14px] text-vs-desc' />
            )}
            <span className={done ? 'text-vs-desc line-through' : active ? 'text-vs-fg' : 'text-vs-fg'}>{t.content}</span>
          </div>
        )
      })}
    </div>
  )
}

function TaskBody({ input, result }: { input: Record<string, unknown>; result?: string }) {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const agent = str(input.subagent_type)
  const prompt = str(input.prompt) ?? str(input.description)
  return (
    <div className='flex flex-col gap-2 px-3 py-2'>
      {agent && (
        <span className='w-fit rounded bg-black/20 px-1.5 py-0.5 font-mono text-[11px] text-vs-desc'>{agent}</span>
      )}
      {prompt && <div className='text-[12px] leading-relaxed text-vs-desc'>{prompt}</div>}
      {result && (
        <pre className='max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-vs-desc'>{result}</pre>
      )}
    </div>
  )
}
