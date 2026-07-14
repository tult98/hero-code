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
		// package that resolves its own bundled CLI via `import.meta.url`, so it must
		// stay an external module loaded from `node_modules` at runtime (via a dynamic
		// `import()`) rather than being bundled into this CJS output.
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
