const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Tailwind v4 has no official esbuild plugin, so we drive its CLI directly:
 * `src/webview/index.css` (which maps VS Code theme vars into utility tokens)
 * is compiled to `dist/webview.css`, loaded by the panel shell via <link>.
 */
const tailwindBin = path.join(__dirname, 'node_modules', '.bin', 'tailwindcss');
const tailwindArgs = ['-i', 'src/webview/index.css', '-o', 'dist/webview.css'];
const spawnOpts = { stdio: 'inherit', shell: process.platform === 'win32' };

function buildTailwind() {
	fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
	const args = production ? [...tailwindArgs, '--minify'] : tailwindArgs;
	const result = spawnSync(tailwindBin, args, spawnOpts);
	if (result.status !== 0) {
		throw new Error('tailwindcss build failed');
	}
}

function watchTailwind() {
	fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
	const child = spawn(tailwindBin, [...tailwindArgs, '--watch'], spawnOpts);
	child.on('error', (err) => console.error('tailwindcss:', err));
}

/**
 * Copy the codicon font + stylesheet into `dist/` so the webview can load them
 * as local resources. `codicon.css` references `./codicon.ttf` relatively, so
 * the two files must sit side by side.
 */
function copyCodicons() {
	const src = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(src, file), path.join(__dirname, 'dist', file));
	}
}

/**
 * Vendor the Claude Agent SDK into `dist/vendor/` so the chat window can load it
 * at runtime. The SDK is ESM-only (can't be bundled into our CJS host) and vsce's
 * node_modules handling makes shipping a single scoped package from node_modules
 * unreliable, so we copy the package's own files into `dist/` — which already
 * ships — and import from there (see src/chat/manager.ts). We deliberately copy
 * ONLY this package, not its ~240MB sibling `claude-agent-sdk-<platform>` CLI
 * binary: the SDK drives the user's installed `claude` via
 * `pathToClaudeCodeExecutable`, so the bundled binary is never needed.
 */
function copyAgentSdk() {
	const src = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	const dest = path.join(__dirname, 'dist', 'vendor', '@anthropic-ai', 'claude-agent-sdk');
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(src, dest, { recursive: true });
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			copyCodicons();
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Extension host: Node/CJS, `vscode` provided by the runtime.
	const hostCtx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		// `vscode` is provided by the runtime. The Claude Agent SDK is an ESM-only
		// package, so it can't be bundled into this CJS output; it is vendored into
		// `dist/vendor/` (see copyAgentSdk) and loaded at runtime via a dynamic
		// `import()` of its absolute path.
		external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	// Webview: browser/IIFE React bundles loaded by a panel shell. React is
	// bundled in (no externals); JSX uses the automatic runtime. Two entries: the
	// sidebar Sessions list and the editor-area chat window.
	const webviewContext = (entry, outfile) =>
		esbuild.context({
			entryPoints: [entry],
			bundle: true,
			format: 'iife',
			jsx: 'automatic',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: 'browser',
			outfile,
			// React/react-dom read `process.env.NODE_ENV`, which doesn't exist in a
			// webview. Substitute it so the bundle loads and picks the right React build.
			define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
			logLevel: 'silent',
		});

	const [webviewCtx, chatCtx] = await Promise.all([
		webviewContext('src/webview/main.tsx', 'dist/webview.js'),
		webviewContext('src/webview/chat/main.tsx', 'dist/chat.js'),
	]);

	const contexts = [hostCtx, webviewCtx, chatCtx];
	// Vendor the ESM-only Agent SDK into dist/ once (it's static — no need to
	// re-copy on watch rebuilds).
	copyAgentSdk();
	if (watch) {
		await Promise.all(contexts.map((c) => c.watch()));
		watchTailwind();
	} else {
		await Promise.all(contexts.map((c) => c.rebuild()));
		await Promise.all(contexts.map((c) => c.dispose()));
		buildTailwind();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
