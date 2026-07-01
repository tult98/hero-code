# Hero Code

Bring your Claude Code sessions into VS Code. Browse running sessions in a sidebar and
jump straight from an editor selection into the session's terminal.

## Features

- **Claude Sessions sidebar** — an activity bar view listing your Claude Code sessions,
  showing status and letting you select which one is active.
- **Hero Code: Send Selection to Claude Session** — inserts an `@file` mention for the
  active editor into the selected session's terminal, without submitting it.
  - With a selection: mentions the specific line range (`@path#L10-20`).
  - With no selection: mentions the whole file (`@path`).
  - Default keybinding: `ctrl+alt+k` (`alt+cmd+k` on macOS), while an editor has focus.

## Requirements

- VS Code `1.90.0` or later.
- [Claude Code](https://claude.com/claude-code) running in a terminal, with an active
  session selected in the Claude Sessions sidebar.

## Getting started

1. Install the extension.
2. Open the **Claude Sessions** view from the activity bar and select a session.
3. Select some code (or place your cursor in a file), then press `alt+cmd+k` /
   `ctrl+alt+k` to mention it in that session's terminal.

## Development

```bash
npm install        # install dependencies
npm run compile    # bundle src/extension.ts → dist/extension.js
```

Then press **F5** in VS Code to launch an Extension Development Host with the extension
loaded.

### Scripts

| Script                 | Description                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run compile`      | Bundle the extension with esbuild.               |
| `npm run watch`        | Rebuild on change (used by the F5 build task).   |
| `npm run package`      | Production (minified) bundle.                    |
| `npm run check-types`  | Type-check with `tsc --noEmit`.                  |
| `npm run lint`         | Lint `src` with ESLint.                          |

### Packaging

```bash
npx vsce package     # produces hero-code-0.0.1.vsix
```

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
