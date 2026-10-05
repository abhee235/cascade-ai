// winFence.test.ts — ADR-070 step 6 / ADR-087: the write-fence's pure parts (runner argv, backend wiring, dialect).
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPolicy } from '@cascade/core'
import { buildChildCommandLine, parseRunnerArgs, redirectChildWrites } from '../src/winFenceRunner.js'
import { confineHostCommand, resetBackendCache, selectLocalBackend } from '../src/sandboxBackends.js'

const ws = mkdtempSync(join(tmpdir(), 'winfence-'))
const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws }
// confineHostCommand labels this workspace on win32 (ADR-087) — leave no labeled folder behind in %TEMP%.
afterAll(() => rmSync(ws, { recursive: true, force: true }))

describe('parseRunnerArgs — the runner contract', () => {
	it('parses a workspace-write invocation', () => {
		const p = parseRunnerArgs(['--workspace', ws, '--mode', 'workspace-write', '--temp-dir', 'T', '--', 'npm test'])
		expect(p).toMatchObject({ workspace: ws, mode: 'workspace-write', tempDir: 'T', command: ['npm test'] })
	})
	it('workspace-write needs no SID — the workspace label grants the tree (ADR-087); a stale --write-sid is ignored', () => {
		expect(parseRunnerArgs(['--workspace', ws, '--mode', 'workspace-write', '--', 'x']).mode).toBe('workspace-write')
		expect(parseRunnerArgs(['--workspace', ws, '--mode', 'workspace-write', '--write-sid', 'S-1-4-1-2', '--', 'x'])).not.toHaveProperty('writeSid')
	})
	it('read-only needs no sid', () => {
		expect(parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', '--', 'ls']).mode).toBe('read-only')
	})
	it('rejects a missing `--` and an empty command', () => {
		expect(() => parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', 'ls'])).toThrow(/missing `--`/)
		expect(() => parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', '--'])).toThrow(/no command/)
	})
})

describe('buildChildCommandLine — cmd /d /s /c wrapper', () => {
	it('wraps the single command element, outer-quoted for cmd /s', () => {
		const line = buildChildCommandLine(['echo hi && dir'])
		expect(line).toMatch(/\/d \/s \/c "echo hi && dir"$/)
	})
})

describe('backend selection — win32 chain', () => {
	it('win32 selects the fence when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'win32', probeWinFence: () => true })).toBe('win-write-fence')
		expect(selectLocalBackend({ platform: 'win32', probeWinFence: () => false })).toBe('none')
		resetBackendCache()
	})
})

describe('confineHostCommand — the fence is argv-form, partial, with a runner-failure signature', () => {
	it('workspace-write: argv runs the runner with the private temp-dir and no SID; command is ONE trailing element', () => {
		const c = confineHostCommand('npm run build', wsWrite, { platform: 'win32', probeWinFence: () => true })
		resetBackendCache()
		expect(c.backend).toBe('win-write-fence')
		expect(c.enforcement).toBe('partial') // honest: writes only, plus the documented boundaries
		expect(c.argv).toBeDefined()
		const argv = c.argv!
		expect(argv).not.toContain('--write-sid') // the label, not a SID, grants the tree (ADR-087)
		expect(argv[argv.indexOf('--temp-dir') + 1]).toBe(join(ws, '.cascade', 'tmp'))
		expect(argv[argv.length - 2]).toBe('--')
		expect(argv[argv.length - 1]).toBe('npm run build') // never split/reshelled
		expect(c.runnerFailureSignatures).toContain('cascade-fence:')
	})
	it('read-only: no temp-dir and no SID (nothing is writable)', () => {
		const c = confineHostCommand('ls', readOnly, { platform: 'win32', probeWinFence: () => true })
		resetBackendCache()
		expect(c.argv).not.toContain('--write-sid')
		expect(c.argv).not.toContain('--temp-dir')
		expect(c.argv![c.argv!.length - 1]).toBe('ls')
	})
	it("the dialect classifies node's EPERM — a denied write and a denied spawn (unmatched before ADR-087)", () => {
		const c = confineHostCommand('ls', readOnly, { platform: 'win32', probeWinFence: () => true })
		resetBackendCache()
		const matches = (out: string) => (c.denialSignatures ?? []).some((s) => out.toLowerCase().includes(s))
		// Verbatim from the P2 trace (2026-09-28) and the fenced tsc -b run (2026-09-29).
		expect(matches('failed to load config from vite.config.ts\nerror during build:\nError: spawn EPERM')).toBe(true)
		expect(matches("error TS5033: Could not write file 'tsconfig.tsbuildinfo': EPERM: operation not permitted, open 'x'")).toBe(true)
		expect(matches('Access is denied.')).toBe(true)
		expect(matches('src/App.tsx(3,1): error TS2304: Cannot find name')).toBe(false) // an ordinary failure stays ordinary
	})
	it('danger-full-access is never confined', () => {
		expect(confineHostCommand('rm -rf /', { mode: 'danger-full-access', workspaceRoot: ws }, { platform: 'win32', probeWinFence: () => true }).backend).toBe('none')
	})
})

describe('redirectChildWrites — %TEMP% AND the npm cache must land inside the granted tree', () => {
	// Regression, measured 2026-09-25 under the REAL fence: npm caches to %LOCALAPPDATA%\npm-cache, outside
	// the workspace ACE, so `npm install` — the first act of every build — died with
	//   npm error code EPERM … path C:\…\npm-cache\_cacache\tmp\f67bfc73
	// and the model escalated to danger-full-access purely to obtain a cache directory. Redirecting %TEMP%
	// alone was never enough; the cache is a separate variable. (Same bug the WSL rung had as EROFS.)
	const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, npm_config_cache: process.env.npm_config_cache }
	afterEach(() => {
		Object.assign(process.env, saved)
	})

	it('redirects TMP, TEMP and npm_config_cache into the workspace-private temp dir', () => {
		const dir = mkdtempSync(join(tmpdir(), 'fence-env-'))
		const tempDir = join(dir, '.cascade', 'tmp')
		const vars = redirectChildWrites({ mode: 'workspace-write', tempDir })!
		expect(vars.TMP).toBe(tempDir)
		expect(vars.TEMP).toBe(tempDir)
		expect(vars.npm_config_cache).toBe(join(tempDir, 'npm-cache'))
		expect(existsSync(vars.npm_config_cache)).toBe(true) // must EXIST — npm fails on the first write otherwise
		expect(process.env.npm_config_cache).toBe(vars.npm_config_cache) // the spawned child inherits this
		rmSync(dir, { recursive: true, force: true })
	})

	it('read-only redirects nothing — a mode that forbids writes forbids cache writes too', () => {
		expect(redirectChildWrites({ mode: 'read-only', tempDir: join(tmpdir(), 'unused') })).toBeUndefined()
	})
})
