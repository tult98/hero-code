export function relativeTime(ageMs: number): string {
  const s = Math.floor(ageMs / 1000)
  if (s < 60) {
    return 'now'
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return `${h}h`
  }
  return `${Math.floor(h / 24)}d`
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
