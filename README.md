# Hero Code

A VS Code extension scaffolded with TypeScript and esbuild.

## Features

- **Hero Code: Hello World** — shows an information message. Run it from the Command
  Palette (`Cmd+Shift+P` → "Hero Code: Hello World").

## Getting started

```bash
npm install        # install dependencies
npm run compile    # bundle src/extension.ts → dist/extension.js
```

Then press **F5** in VS Code to launch an Extension Development Host with the extension
loaded.

## Scripts

| Script               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `npm run compile`    | Bundle the extension with esbuild.               |
| `npm run watch`      | Rebuild on change (used by the F5 build task).   |
| `npm run package`    | Production (minified) bundle.                    |
| `npm run check-types`| Type-check with `tsc --noEmit`.                  |
| `npm run lint`       | Lint `src` with ESLint.                          |

## Packaging

```bash
npx vsce package     # produces hero-code-0.0.1.vsix
```

> Set a real `publisher` in `package.json` before publishing to the Marketplace.
