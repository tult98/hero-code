import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'

/**
 * The user's real login shell. This is what VS Code's integrated terminal spawns
 * too, so anything we run through it resolves PATH the same way a terminal does.
 */
export function loginShell(): string {
  return process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
}

/** Memoized per binary name — `undefined` is a real answer and is cached too. */
const cache = new Map<string, string | undefined>()

/**
 * Locate an executable the extension host may not see on its own PATH. GUI
 * launches of VS Code routinely inherit a bare PATH that omits `~/.local/bin`
 * and `/opt/homebrew/bin`, so we probe the well-known absolute spots first and
 * only then pay for a login shell.
 *
 * Memoized because the login-shell probe costs 300–1500ms (it sources the user's
 * rc files) and must never run twice or land on an activation path.
 */
export function findExecutable(name: string, candidates: string[]): string | undefined {
  if (cache.has(name)) {
    return cache.get(name)
  }
  const found = probe(name, candidates)
  cache.set(name, found)
  return found
}

function probe(name: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // Last resort: ask a login shell to resolve the name on the user's real PATH.
  try {
    const out = execFileSync(loginShell(), ['-lic', `command -v ${name}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out && path.isAbsolute(out) && fs.existsSync(out)) {
      return out
    }
  } catch {
    // No login shell / not on PATH — fall through.
  }

  return undefined
}
