import * as fs from 'fs'
import * as path from 'path'
import type { ContentBlock, ParsedSession, RawEntry, ToolInput } from './types.js'

/**
 * Claude Code stores each session as a `.jsonl` file under
 * `~/.claude/projects/<encoded-cwd>/`, where the directory name is the project
 * path with every non-alphanumeric character replaced by `-`.
 */
export function encodeProjectPath(folderPath: string): string {
  return folderPath.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Slash-command / tool wrapper tags that aren't meaningful prompt text. */
function isMeta(s: string): boolean {
  return /^<(local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)/.test(
    s.trimStart(),
  )
}

/** A short, human label for the last assistant tool use. */
function describeTool(name: string, input: ToolInput | undefined): string {
  const i = input ?? {}
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return i.file_path ? `${name} · ${path.basename(i.file_path)}` : name
    case 'Bash':
      return i.description ? `Bash · ${i.description}` : i.command ? `Bash · ${i.command}` : 'Bash'
    case 'Grep':
    case 'Glob':
      return i.pattern ? `${name} · ${i.pattern}` : name
    case 'Task':
      return i.description ? `Task · ${i.description}` : 'Task'
    default:
      return name
  }
}

/**
 * Parse a session `.jsonl` into the fields we can show. Everything here is
 * read straight from the transcript — title and last activity.
 * Returns null for sessions with no usable title (empty sessions).
 */
export function parseSession(filePath: string): ParsedSession | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  let aiTitle: string | undefined
  let lastPrompt: string | undefined
  let firstUser: string | undefined
  let activity: string | undefined
  let stopReason: string | undefined
  let gitBranch: string | undefined
  let errored = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let entry: RawEntry
    try {
      entry = JSON.parse(trimmed) as RawEntry
    } catch {
      continue
    }

    // Outside the switch: system/attachment entries carry it too.
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) {
      gitBranch = entry.gitBranch
    }

    switch (entry.type) {
      case 'ai-title':
        if (entry.aiTitle) {
          aiTitle = entry.aiTitle
        }
        break
      case 'last-prompt':
        if (entry.lastPrompt) {
          lastPrompt = entry.lastPrompt
        }
        break
      case 'user': {
        const c = entry.message?.content
        if (typeof c === 'string' && !isMeta(c)) {
          // A typed user prompt — counts as the latest activity.
          if (firstUser === undefined) {
            firstUser = c
          }
          activity = c
        }
        break
      }
      case 'assistant': {
        // The last assistant turn tells us whether work is in progress
        // (`tool_use`) or finished (`end_turn`), and whether it errored.
        const sr = entry.message?.stop_reason
        if (typeof sr === 'string' && sr) {
          stopReason = sr
        }
        errored = !!(entry.isApiErrorMessage || entry.error)

        const blocks = entry.message?.content
        if (!Array.isArray(blocks)) {
          break
        }
        for (const b of blocks as ContentBlock[]) {
          if (b?.type === 'tool_use') {
            activity = describeTool(b.name ?? '', b.input)
          } else if (b?.type === 'text' && b.text?.trim() && !isMeta(b.text)) {
            activity = b.text.trim()
          }
        }
        break
      }
    }
  }

  const title = aiTitle ?? lastPrompt ?? firstUser
  if (!title) {
    return null
  }

  const clean = (s: string) => s.split('\n')[0].trim()
  return {
    title: clean(title).slice(0, 120),
    activity: activity ? clean(activity).slice(0, 120) : undefined,
    stopReason,
    gitBranch,
    errored,
  }
}
