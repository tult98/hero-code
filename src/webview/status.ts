import type { Status } from '../types.js'

export const STATUS_LABEL: Record<Status, string> = {
  working: 'Working',
  waiting: 'Waiting',
  ready: 'Ready',
  error: 'Error',
  idle: 'Idle',
}

/** Verbose status wording for the row's meta line (the dot carries the color). */
export const STATUS_TEXT: Record<Status, string> = {
  working: 'Working…',
  waiting: 'Waiting for input',
  ready: 'Ready',
  error: 'Error',
  idle: 'Idle',
}

/**
 * Codicon name per status, rendered as `<span class="codicon codicon-<name>">`.
 * `working` additionally gets `codicon-modifier-spin` for the animated loader.
 */
export const STATUS_ICON: Record<Status, string> = {
  working: 'loading',
  waiting: 'circle-filled',
  ready: 'circle-filled',
  error: 'error',
  idle: 'circle-outline',
}

/**
 * Tailwind classes applied to the status indicator. Colors resolve to VS Code
 * theme variables via the `vs-*` tokens in `index.css`; `waiting` also pulses —
 * it is the one state that needs the user, so it is the one that draws the eye.
 * `ready` is live but unblocked: solid green, no motion.
 * Full literal class strings so Tailwind's scanner can see them.
 */
export const STATUS_COLOR: Record<Status, string> = {
  working: 'text-vs-blue',
  waiting: 'text-vs-yellow animate-scpulse',
  ready: 'text-vs-green',
  error: 'text-vs-red',
  idle: 'text-vs-desc',
}
