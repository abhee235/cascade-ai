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
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

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
 * `koffi` (the Windows write-fence's FFI, ADR-070 step 6) is a NATIVE addon — a `.node` binary cannot be
 * inlined into a JS bundle, and it is N-API, so the one prebuilt serves Node and Electron alike. It is
 * copied out beside the others below.
 *
 * All four stay real dependencies, so the packager copies them intact.
 *
 * `cpu-features` and any other `*.node` file are left out for a different reason: `ssh2` (pulled in by
 * the Docker client) loads its optional native speed-ups — `sshcrypto.node`, `cpu-features` — inside
 * try/catch and falls back to plain JS without them. npm compiles them on macOS and Linux (not on a
 * Windows box without build tools), and esbuild has no loader for a compiled `.node`, so bundling them
 * failed the build there. Left external they are simply absent at runtime, which ssh2 already handles.
 */
const EXTERNAL = ['electron', 'playwright-core', 'typescript', 'koffi', 'cpu-features', '*.node']

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

// The EXTERNAL dependencies, copied out as a real node_modules tree.
//
// These are excluded from the bundle on purpose (see EXTERNAL above), which means they must exist on disk
// at runtime. A monorepo HOISTS them to the repo root, so the packager — which copies only this package's
// own directory — ships neither, and the failure is late and confusing: the server starts fine, then the
// Browser tool and the LSP throw "Cannot find package" the first time anything uses them.
//
// They land beside server.mjs in the app's resources directory, which is exactly where Node's ordinary
// upward resolution looks. Both happen to be dependency-free, so a flat copy is the whole story.
console.log('• copying external dependencies…')
// koffi 3.x ships its NATIVE binary in a separate per-platform package (`@koromix/koffi-<platform>-<arch>`,
// an optionalDependency that `koffi/index.cjs` requires at load) — copying `koffi` alone ships a loader with
// nothing to load, and the failure only appears in the packaged app (measured: no .node anywhere in the
// first package). Copy the one for the platform being built.
const koffiNative = `@koromix/koffi-${process.platform}-${process.arch}`
for (const dep of ['playwright-core', 'typescript', 'koffi', koffiNative]) {
	const src = join(REPO, 'node_modules', dep)
	if (!existsSync(src)) throw new Error(`external dependency missing: node_modules/${dep} — run npm install at the repo root`)
	cpSync(src, join(DIST, 'node_modules', dep), { recursive: true, dereference: true })
}

// ── ADR-070 Part D: the zero-install sandbox resources → dist/sandbox/<platform>/ ─────────────────────
//
// Per-platform binaries fetched by scripts/fetch-sandbox.mts into packages/desktop/sandbox-bin/<platform>/
// (gitignored, cached like browsers/): mise, a portable Node LTS, and on Linux a static bwrap. Plus two
// built here: the Windows fence runner (bundled, koffi external — it resolves koffi from the
// resources/node_modules copied above via ordinary upward resolution) and the WSL rootfs, gzipped
// (`wsl --import` accepts .tar.gz; ~230 MB → ~80 MB, the single largest installer cost).
//
// Every piece is OPTIONAL at build time with a loud warning, mirroring the browser: the app still runs
// without them, degraded exactly as a source checkout would be (mise dormant, host node, WSL not offered).
// CASCADE_SKIP_SANDBOX_ASSETS=1 silences the warnings for a deliberately slim dev build.
const PLATFORM = process.platform
const SANDBOX_BIN = join(HERE, 'sandbox-bin', PLATFORM)
const SANDBOX_OUT = join(DIST, 'sandbox', PLATFORM)
mkdirSync(SANDBOX_OUT, { recursive: true })
const warnMissing = (what: string, fix: string) => {
	if (!process.env.CASCADE_SKIP_SANDBOX_ASSETS) console.warn(`! sandbox: ${what} not found — ${fix}`)
}

console.log('• sandbox: fetched binaries (mise, node, bwrap)…')
// ADR-088: a RELEASE must carry its toolchain. v0.1.0 packaged with only the warning below, and a fresh
// machine then had no npm at all. CI sets CASCADE_REQUIRE_SANDBOX=1 so the same gap fails the build instead.
if (process.env.CASCADE_REQUIRE_SANDBOX === '1') {
	const required = ['node', PLATFORM === 'win32' ? 'mise.exe' : 'mise', ...(PLATFORM === 'win32' ? [join('git', 'usr', 'bin', 'sh.exe')] : [])]
	const missing = required.filter((f) => !existsSync(join(SANDBOX_BIN, f)))
	if (missing.length) throw new Error(`sandbox: missing ${missing.join(', ')} in packages/desktop/sandbox-bin/${PLATFORM} — run scripts/fetch-sandbox.mts`)
}
if (existsSync(SANDBOX_BIN)) {
	cpSync(SANDBOX_BIN, SANDBOX_OUT, { recursive: true, dereference: true })
} else {
	warnMissing(`packages/desktop/sandbox-bin/${PLATFORM}`, 'run: npx tsx packages/desktop/scripts/fetch-sandbox.mts')
}

if (PLATFORM === 'win32') {
	console.log('• sandbox: bundling the write-fence runner…')
	await build({
		entryPoints: [join(REPO, 'packages', 'server', 'src', 'winFenceRunner.ts')],
		outfile: join(SANDBOX_OUT, 'winFenceRunner.mjs'),
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		external: ['koffi'],
		minify: false,
		sourcemap: false,
		logLevel: 'warning',
	})

	// The rootfs: built by scripts/build-wsl-rootfs.ps1 (→ <repo>/dist/wsl/), gzipped here.
	const rootfsSrc = process.env.CASCADE_WSL_ROOTFS_SRC ?? join(REPO, 'dist', 'wsl', 'cascade-sandbox-rootfs.tar')
	if (existsSync(rootfsSrc)) {
		console.log('• sandbox: gzipping the WSL rootfs (this takes a minute)…')
		await pipeline(createReadStream(rootfsSrc), createGzip({ level: 6 }), createWriteStream(join(SANDBOX_OUT, 'cascade-sandbox-rootfs.tar.gz')))
	} else {
		warnMissing('the WSL rootfs', 'run: .\\scripts\\build-wsl-rootfs.ps1 (or set CASCADE_WSL_ROOTFS_SRC)')
	}
}

// The headless Chromium the Browser tool drives (ADR-081 §7).
//
// Bundled rather than downloaded on first use, because the tool is how the agent LOOKS AT what it built —
// a build that silently cannot see its own output is worse than a larger download. It is also pinned to
// this exact playwright-core: the two are a matched pair, and a mismatch fails with the unhelpful
// "Executable doesn't exist" (measured — the machine's own Chromium was revision 1228 against a
// playwright-core wanting 1234).
//
// ~275MB, which is the honest cost. Set CASCADE_SKIP_BROWSER=1 to build without it; the tool then falls
// back to the system Edge/Chrome exactly as a source checkout does.
if (process.env.CASCADE_SKIP_BROWSER) {
	console.log('• skipping bundled browser (CASCADE_SKIP_BROWSER)')
} else if (existsSync(join(HERE, 'browsers'))) {
	console.log('• copying bundled browser…')
	cpSync(join(HERE, 'browsers'), join(DIST, 'browsers'), { recursive: true })
} else {
	// Loud, because the alternative is shipping a build whose Browser tool quietly does not work.
	console.warn('! no packages/desktop/browsers — run: PLAYWRIGHT_BROWSERS_PATH=packages/desktop/browsers npx playwright install chromium --only-shell')
}

// A marker the shell can check, so "did the build actually run" is answerable at runtime.
writeFileSync(join(DIST, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2))
console.log('✓ desktop build ready →', DIST)
