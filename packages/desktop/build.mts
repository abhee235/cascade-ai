// build.mts — produce everything the Electron shell needs (ADR-081 §7).
//
// Three outputs, all into packages/desktop/dist:
//   main.mjs     the Electron main process
//   server.mjs   the WHOLE server, bundled — the existing composition root, unchanged
//   web/         the built web bundle the window loads
//
// The server is bundled rather than shipped as source because it is TypeScript: `tsx` is a dev
// dependency, and a packaged app has no compiler. Bundling is also what lets `npm prune` leave the app
// with almost no node_modules.
//
// ESM, not CJS: the composition root uses TOP-LEVEL await (it opens the DB and runs migrations before
// starting), which CJS cannot express. Electron has supported ESM main since 28.

import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(HERE, 'dist')

/**
 * Left OUT of the bundle.
 *
 * `electron` is provided by the runtime and must never be pulled in. `playwright-core` resolves its own
 * driver and browser paths relative to its package directory at RUNTIME — bundling it produces a file
 * that cannot find the very things it exists to launch. `typescript` (the LSP engine, core/lsp/tsService)
 * is a 10MB CJS library that reads `__filename`, which cannot coexist with this bundle's top-level await:
 * Node refuses to guess the module format and throws before the server starts.
 *
 * All three stay real dependencies of this package, so the packager copies them intact.
 */
const EXTERNAL = ['electron', 'playwright-core', 'typescript']

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

console.log('• bundling server…')
await build({
	entryPoints: [join(REPO, 'packages', 'server', 'src', 'main.ts')],
	outfile: join(DIST, 'server.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	external: EXTERNAL,
	// Electron's Node is 24; keeping names makes a production stack trace readable, which matters more
	// here than the few hundred KB minification would save on a binary that already ships Chromium.
	minify: false,
	sourcemap: true,
	logLevel: 'warning',
	banner: {
		// Re-create the CommonJS globals inside an ESM bundle.
		//
		// Plenty of transitive dependencies are CJS and reach for `require`, `__dirname` or `__filename` —
		// ssh2 (via dockerode) does all three. In an ESM output none of them exist, and the failure is not a
		// tidy "undefined variable": Node reports "Cannot determine intended module format because both
		// '__dirname' and top-level await are present" and refuses to load the file at all, so the server
		// never starts and the window sits on a spinner.
		js: [
			"import { createRequire as __cascadeCreateRequire } from 'node:module';",
			"import { fileURLToPath as __cascadeFileURLToPath } from 'node:url';",
			"import { dirname as __cascadeDirname } from 'node:path';",
			'const require = __cascadeCreateRequire(import.meta.url);',
			'const __filename = __cascadeFileURLToPath(import.meta.url);',
			'const __dirname = __cascadeDirname(__filename);',
		].join(''),
	},
})

console.log('• bundling electron main…')
await build({
	entryPoints: [join(HERE, 'src', 'main.ts')],
	outfile: join(DIST, 'main.cjs'),
	bundle: true,
	platform: 'node',
	// CJS: Electron's main process is a CommonJS host — see the note at the top of src/main.ts.
	format: 'cjs',
	target: 'node22',
	external: EXTERNAL,
	sourcemap: true,
	logLevel: 'warning',
})

console.log('• building web…')
execFileSync('npm', ['run', 'build', '-w', '@cascade/web'], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' })
cpSync(join(REPO, 'packages', 'web', 'dist'), join(DIST, 'web'), { recursive: true })

// The server's shipped assets. `resources.ts` reads CASCADE_RESOURCES to find these; without them the app
// starts fine and then has no skills, no agent definitions and no templates — a failure that looks like
// stupidity rather than breakage, which is exactly why it is copied here explicitly and asserted below.
console.log('• copying server resources…')
for (const dir of ['skills', 'agents', 'templates']) {
	cpSync(join(REPO, 'packages', 'server', dir), join(DIST, 'resources', dir), { recursive: true })
}

// A marker the shell can check, so "did the build actually run" is answerable at runtime.
writeFileSync(join(DIST, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2))
console.log('✓ desktop build ready →', DIST)
