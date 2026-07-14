# Changelog

All notable changes to the "Hero Code" extension will be documented in this file.

## [0.0.12] - 2026-07-14

### Added

- Filter sessions by status. A row of multi-select chips (All / Working / Waiting / Idle /
  Error) sits under the search box; each chip shows a live count of matching sessions. Tap
  chips to show only those statuses — they combine with each other and with the text
  search. The filter is transient and resets when the panel is reopened.

## [0.0.11] - 2026-07-14

### Changed

- Sessions now hold a stable, newest-first position in the sidebar instead of reordering as
  they work. Rows are ordered by the session's creation time rather than its transcript's
  last-write time, so a working session no longer jumps to the top on every turn, and a
  session no longer moves when its process starts or stops. Status is still shown via each
  row's icon and label.

## [0.0.10] - 2026-07-04

### Changed

- The `heroCode.debugMode` hover tooltip (launch id / live id / PID) now shows when
  hovering anywhere on a session row and appears immediately, instead of only in the gaps
  between the row's icons/buttons and after the browser's tooltip delay. While debug mode
  is on, the row's other native tooltips are suppressed so they don't compete with it.

## [0.0.9] - 2026-07-04

### Changed

- Pinned sessions are now lifted into a single collapsible **Pinned** section at the top
  of the sidebar, directly below the search bar and above all folder groups, instead of
  floating to the top of their own folder. A pinned session is removed from its folder
  group while pinned and returns to it when unpinned. Pins from multiple workspace folders
  share the one Pinned section.

### Added

- New `heroCode.debugMode` setting: when enabled, hovering a session row shows a debug
  tooltip with its launch id, live id, and PID.

### Fixed

- Sessions no longer render as duplicate rows when several terminals resume the same
  session: every diverged live id (not just the winning process's) is now aliased, and
  the winning live process is picked deterministically (most-active: busy first, then
  most-recently updated) instead of depending on registry file read order.

## [0.0.8] - 2026-07-02

### Added

- Each session row now shows the git branch it is working on (from the transcript's
  per-entry `gitBranch` field) on its own line under the status. Useful in multi-repo
  workspaces to see at a glance which branch each session is on. Sessions in
  non-git directories show no branch.

## [0.0.7] - 2026-07-02

### Fixed

- Bound the `Shift+Cmd+C` / `Ctrl+Shift+C` shortcut to the view-container command
  (`workbench.view.extension.hero-code-sessions`) so the activity-bar icon tooltip
  shows the shortcut, e.g. "Claude Sessions (⇧⌘C)".

## [0.0.6] - 2026-07-02

### Added

- Keyboard shortcut `Shift+Cmd+C` (Mac) / `Ctrl+Shift+C` (Win/Linux) opens/focuses
  the Claude Sessions sidebar. Uses the auto-generated `hero-code.sessions.focus`
  command; overrides VS Code's default "Open New External Terminal" binding.

## [0.0.5] - 2026-07-02

### Changed

- Rewrote the README and Marketplace description to lead with what the extension is for:
  managing multiple Claude Code sessions at once with realtime status, one-click new
  sessions, and pin / rename / mark-done for keeping sessions organized.

### Added

- Added a Claude Sessions sidebar screenshot to the Marketplace listing.

## [0.0.4] - 2026-07-01

### Fixed

- Actively working sessions that had been `/cleared` no longer show as "Idle" with
  a stuck "New session" placeholder. When a cleared session's launch transcript was
  never written to disk, its live conversation is now surfaced on a single row that
  reflects the real status (Working / Waiting for input).
- Clicking such a row now opens its terminal instead of failing with "Could not
  locate the workspace folder for this session" — resume and workspace lookup follow
  the live session id while the row stays tracked under its stable id.

## [0.0.3] - 2026-07-01

### Fixed

- Running sessions no longer show as "Idle" after `/clear`. A session's terminal
  keeps running under a new session id when you clear it; the row now tracks that
  live session in place (keeping its pin, name, and position) instead of going idle
  and spawning a duplicate row.

### Changed

- Session status now comes from Claude Code's live process registry
  (`~/.claude/sessions`) — Working / Waiting for input / Idle — which is more
  accurate and avoids transcript lag. Freshly cleared sessions with no messages
  yet are not listed.

## [0.0.2] - 2026-07-01

### Changed

- Replaced the Marketplace icon with a higher-resolution version.

## [0.0.1] - 2026-07-01

### Added

- Sessions sidebar (Claude Sessions activity bar view) for browsing Claude Code sessions.
- `Hero Code: Send Selection to Claude Session` command, bound to `ctrl+alt+k` (`alt+cmd+k` on macOS).
