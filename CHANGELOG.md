# Changelog

All notable changes to the "Hero Code" extension will be documented in this file.

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
