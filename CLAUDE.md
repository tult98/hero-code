# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workflow

- **Push directly to `main`. Do NOT create pull requests.** Commit changes and push
  straight to `main`; no feature branches or PRs are needed unless explicitly requested.

## Project

Hero Code is a VS Code extension that adds a **Sessions** sidebar for managing Claude Code
sessions across the open workspace folders — listing each session with its live status
(Working / Waiting for input / Idle / Error) and letting you open/resume its terminal.

## Commands

- `npm run compile` — build the extension + webview bundle (esbuild) into `dist/`
- `npm run watch` — rebuild on change (used as the F5 pre-launch task)
- `npm run check-types` — `tsc --noEmit` for both the host and webview tsconfigs
- `npm run lint` — ESLint over `src`
- `npm run package` — production build; `npx vsce package` produces the `.vsix`
- **F5** ("Run Extension") launches an Extension Development Host running `dist/`

## Architecture

- `src/extension.ts` — activation; registers the webview view provider and the
  "mention in session" command; calls `reconnectTerminals()` on startup.
- `src/sessions.ts` — the core: scans transcripts in
  `~/.claude/projects/<encoded-cwd>/*.jsonl` and joins them with live processes from
  Claude's registry `~/.claude/sessions/<pid>.json` to derive each row's status.
  Handles `/clear` (live session id diverges from the launch id the extension tracks).
- `src/view.ts` — `SessionsViewProvider`: builds the state, posts it to the webview,
  polls every 5s while visible, and handles messages (open/pin/rename/done/new).
- `src/terminal.ts` — creates/reveals/adopts session terminals; resumes via
  `claude --resume <id>` and re-adopts terminals after a window reload by name marker.
- `src/webview/` — the React sidebar UI (`App.tsx`, `Group.tsx`, `Row.tsx`,
  `status.ts` for label/icon/color maps).
- `src/types.ts` — shared types (`Status`, `SessionItem`, `SessionMeta`, etc.).

## Key concepts

- **Launch id vs live id**: the extension tracks a session by its _launch_ id
  (`--session-id`/`--resume`, stable, used for terminals, pins, and metadata). Claude
  assigns a new _live_ session id on `/clear`. Rows stay keyed by the stable launch id;
  `SessionItem.liveId` carries the current live id when they differ (used for resume and
  workspace resolution).
- Per-session user metadata (pin / custom name / done) is persisted in the extension
  host's `globalState`, keyed by session id, and merged into each row.
