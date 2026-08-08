// ADR-081 §7 — the invariants that only break once PACKAGED.
//
// Everything here passes trivially in dev and fails on a user's machine, which is the worst shape a bug
// can have: the code is fine in every environment a developer looks at. Each case below is one that was
// actually hit while producing the first build.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_SRC = join(import.meta.dirname, '..', 'src')
const DESKTOP = join(import.meta.dirname, '..', '..', 'desktop')
const read = (p: string) => readFileSync(p, 'utf8')

describe('packaging invariants', () => {
	it('shipped assets resolve through the resource root, not the module location', () => {
		// Bundling collapses the server into one file somewhere else entirely, so anything derived from
		// `import.meta.dirname` points at a directory that does not exist. The failure is silent: no skills
		// load, no agent definitions, no templates, and the app looks stupid rather than broken.
		for (const file of ['projectManager.ts', 'templates.ts']) {
			const src = read(join(SERVER_SRC, file))
			expect(src, `${file} must use resourceDir() for shipped assets`).not.toMatch(/import\.meta\.dirname[^\n]*(skills|agents|templates)/)
		}
		expect(read(join(SERVER_SRC, 'resources.ts'))).toMatch(/CASCADE_RESOURCES/)
	})

	it('the desktop build copies every asset directory the server reads', () => {
		// A resource root is only worth having if the build actually puts the resources there.
		const build = read(join(DESKTOP, 'build.mts'))
		for (const dir of ['skills', 'agents', 'templates']) expect(build, `build.mts must copy ${dir}`).toMatch(new RegExp(`'${dir}'`))
	})

	it('a packaged build reads .env ONLY from its app-data directory', () => {
		// Measured: the packaged .exe walked up from the bundle and loaded the DEVELOPER's .env, inheriting
		// real API keys. It was harmless on a user's machine only because that file happens not to exist —
		// luck, not design. A double-clicked app's cwd is arbitrary, and the bundle lives in Program Files.
		const src = read(join(SERVER_SRC, 'loadDotEnv.ts'))
		expect(src).toMatch(/CASCADE_RESOURCES/)
		expect(src).toMatch(/CASCADE_APP_DATA/)
	})

	it('the shell loads the UI over HTTP, never from file://', () => {
		// A file:// page has origin "null": the WebSocket Origin check rejects it and /token cannot be
		// fetched, so the window opens and sits on a connecting spinner with nothing to explain why.
		const main = read(join(DESKTOP, 'src', 'main.ts'))
		expect(main).toMatch(/loadURL\(/)
		expect(main).not.toMatch(/loadFile\(/)
	})

	it('the server can serve the built web bundle, and confines it to the web root', () => {
		// This listens on a real port. Path traversal is the first thing anything scanning it will try.
		const src = read(join(SERVER_SRC, 'wsServer.ts'))
		expect(src).toMatch(/CASCADE_WEB_ROOT/)
		expect(src).toMatch(/startsWith\(root \+ sep\)/)
	})

	it('the desktop window origin is allowed to open the WebSocket', () => {
		// The shell serves the app from the server's own port, so that origin must pass verifyWsClient —
		// otherwise the packaged app is the one client that cannot connect.
		expect(read(join(SERVER_SRC, 'wsServer.ts'))).toMatch(/http:\/\/127\.0\.0\.1:\$\{PORT\}/)
	})

	it('the server exposes dispose(), so quitting flushes buffered writes', () => {
		// Spans and chat replay events are buffered by design (the agent loop must never await telemetry).
		// Without this the last turn's telemetry and transcript are lost on every quit.
		expect(read(join(SERVER_SRC, 'main.ts'))).toMatch(/export const dispose/)
		expect(read(join(DESKTOP, 'src', 'main.ts'))).toMatch(/before-quit/)
	})

	it('keeps the CJS-only dependencies out of the ESM server bundle', () => {
		// typescript (the LSP engine) and ssh2 (via dockerode) read __dirname/__filename. Combined with the
		// bundle's top-level await, Node refuses to even determine the module format and the server never
		// starts. typescript is externalised; the rest are covered by the CJS-globals banner.
		const build = read(join(DESKTOP, 'build.mts'))
		expect(build).toMatch(/'typescript'/)
		expect(build).toMatch(/__dirname/)
		expect(build).toMatch(/playwright-core/)
	})

	it('packages the app so the database lives OUTSIDE the asar', () => {
		// node:sqlite opens a real file; an asar is a virtual filesystem only Node's patched fs understands.
		// State also must not sit in the install directory, which an update replaces wholesale.
		expect(read(join(DESKTOP, 'forge.config.cjs'))).toMatch(/extraResource/)
		expect(read(join(DESKTOP, 'src', 'main.ts'))).toMatch(/getPath\('userData'\)/)
	})
})
