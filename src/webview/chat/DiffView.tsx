export interface DiffRow {
  type: 'ctx' | 'add' | 'del'
  text: string
}

/**
 * A minimal line diff for display: trim the common prefix/suffix, then show the
 * removed lines followed by the added lines, with a few lines of surrounding
 * context. Not a full LCS — fidelity is fine for a compact edit preview.
 */
export function computeDiff(oldStr: string, newStr: string): { rows: DiffRow[]; added: number; removed: number } {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const CTX = 3
  const rows: DiffRow[] = []
  for (let i = Math.max(0, start - CTX); i < start; i++) {
    rows.push({ type: 'ctx', text: a[i] })
  }
  for (let i = start; i < endA; i++) {
    rows.push({ type: 'del', text: a[i] })
  }
  for (let i = start; i < endB; i++) {
    rows.push({ type: 'add', text: b[i] })
  }
  for (let i = endA; i < Math.min(a.length, endA + CTX); i++) {
    rows.push({ type: 'ctx', text: a[i] })
  }
  return { rows, added: endB - start, removed: endA - start }
}

const ROW_CLASS: Record<DiffRow['type'], string> = {
  add: 'bg-vs-green/10 text-vs-green',
  del: 'bg-vs-red/10 text-vs-red',
  ctx: 'text-vs-desc',
}

const ROW_SIGN: Record<DiffRow['type'], string> = { add: '+', del: '−', ctx: ' ' }

export function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const { rows } = computeDiff(oldStr, newStr)
  return (
    <div className='overflow-x-auto font-mono text-[11.5px] leading-relaxed'>
      {rows.map((r, i) => (
        <div key={i} className={`whitespace-pre px-2.5 ${ROW_CLASS[r.type]}`}>
          <span className='select-none inline-block w-3.5'>{ROW_SIGN[r.type]}</span>
          {r.text}
        </div>
      ))}
    </div>
  )
}
