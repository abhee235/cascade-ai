// sandboxBackends.test.ts — ADR-070 step 4: profiles, probes, selection matrix, confinement wrapping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, type SandboxPolicy } from '@cascade/core'
import { bwrapArgs, confineHostCommand, fenceRunnerArgv, fenceRunnerEnv, resetBackendCache, seatbeltProfile, selectLocalBackend, shq, wrapCommand } from '../src/sandboxBackends.js'
import { writeFileSync } from 'node:fs'
import { HostSandbox } from '../src/hostSandbox.js'

const ws = mkdtempSync(join(tmpdir(), 'sbxbackend-'))
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws }
const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }

let savedSandbox: string | undefined
beforeEach(() => {
	savedSandbox = process.env.CASCADE_SANDBOX
	delete process.env.CASCADE_SANDBOX
	resetBackendCache()
})
afterEach(() => {
	if (savedSandbox === undefined) delete process.env.CASCADE_SANDBOX
	else process.env.CASCADE_SANDBOX = savedSandbox
	resetBackendCache()
})

describe('shq — POSIX single-quote escaping', () => {
	it('wraps and escapes embedded quotes', () => {
		expect(shq('echo hi')).toBe(`'echo hi'`)
		expect(shq("it's")).toBe(`'it'\\''s'`)
	})
})

describe('bwrap profile — read-only world, writable roots re-bound on top', () => {
	it('read-only re-binds nothing writable', () => {
		const args = bwrapArgs(readOnly)
		expect(args.join(' ')).toContain('--ro-bind / /')
		expect(args).not.toContain('--bind')
		expect(args).toContain('--die-with-parent')
	})
	it('workspace-write re-binds exactly the shared writableRoots derivation', () => {
		const args = bwrapArgs(wsWrite)
		expect(args).toContain('--bind')
		expect(args).toContain(canonicalPath(ws)) // the workspace, canonical — same identity the file tools use
		expect(args).toContain('/tmp')
	})
})

describe('seatbelt profile — allow default, deny file-write*, re-allow per root', () => {
	it('read-only allows no write subpath', () => {
		const p = seatbeltProfile(readOnly)
		expect(p).toContain('(deny file-write*)')
		expect(p).not.toContain('(allow file-write*')
	})
	it('workspace-write re-allows each writable root by subpath', () => {
		const p = seatbeltProfile(wsWrite)
		expect(p).toContain(`(allow file-write* (subpath "${canonicalPath(ws).replaceAll('\\', '\\\\')}"))`)
		expect(p).toContain('(allow file-write* (subpath "/tmp"))')
	})
})

describe('wrapCommand', () => {
	it('bwrap: full invocation around /bin/sh -c with the command quoted', () => {
		const w = wrapCommand('bwrap', 'npm test', readOnly)
		expect(w.startsWith("'bwrap' --ro-bind / /")).toBe(true) // binary quoted: a bundled path may contain spaces
		expect(w).toContain(`-- /bin/sh -c 'npm test'`)
	})
	it('seatbelt: profile passed inline, command quoted', () => {
		const w = wrapCommand('seatbelt', 'npm test', wsWrite)
		expect(w.startsWith(`sandbox-exec -p '`)).toBe(true)
		expect(w).toContain(`/bin/sh -c 'npm test'`)
	})
	it('none: identity', () => {
		expect(wrapCommand('none', 'npm test', readOnly)).toBe('npm test')
	})
})

describe('bundled binaries (ADR-070 Part D) — the packaged app points at shipped files', () => {
	const saved = { bwrap: process.env.CASCADE_BWRAP_PATH, runner: process.env.CASCADE_FENCE_RUNNER }
	afterEach(() => {
		if (saved.bwrap === undefined) delete process.env.CASCADE_BWRAP_PATH
		else process.env.CASCADE_BWRAP_PATH = saved.bwrap
		if (saved.runner === undefined) delete process.env.CASCADE_FENCE_RUNNER
		else process.env.CASCADE_FENCE_RUNNER = saved.runner
	})
	it('CASCADE_BWRAP_PATH: an existing bundled bwrap is what the wrap invokes; a missing one falls back to PATH', () => {
		const bundled = join(mkdtempSync(join(tmpdir(), 'bwrapbin-')), 'bwrap')
		writeFileSync(bundled, '')
		process.env.CASCADE_BWRAP_PATH = bundled
		expect(wrapCommand('bwrap', 'ls', readOnly).startsWith(`'${bundled}' --ro-bind`)).toBe(true)
		process.env.CASCADE_BWRAP_PATH = join(tmpdir(), 'does-not-exist', 'bwrap')
		expect(wrapCommand('bwrap', 'ls', readOnly).startsWith("'bwrap' --ro-bind")).toBe(true)
	})
	it('CASCADE_FENCE_RUNNER: an existing bundled runner replaces the tsx dev invocation', () => {
		const savedNode = process.env.CASCADE_NODE_DIR
		delete process.env.CASCADE_NODE_DIR
		const bundled = join(mkdtempSync(join(tmpdir(), 'fencebin-')), 'winFenceRunner.mjs')
		writeFileSync(bundled, '')
		process.env.CASCADE_FENCE_RUNNER = bundled
		expect(fenceRunnerArgv()).toEqual([process.execPath, bundled])
		delete process.env.CASCADE_FENCE_RUNNER
		expect(fenceRunnerArgv()).toContain('tsx') // dev path when nothing is bundled and nothing is built
		if (savedNode !== undefined) process.env.CASCADE_NODE_DIR = savedNode
	})
	it('the runner is HOSTED by the bundled node when shipped — a console-subsystem host is what lets a restricted child init', () => {
		const savedNode = process.env.CASCADE_NODE_DIR
		const nodeDir = mkdtempSync(join(tmpdir(), 'nodehost-'))
		const exe = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
		writeFileSync(exe, '')
		process.env.CASCADE_NODE_DIR = nodeDir
		expect(fenceRunnerArgv()[0]).toBe(exe)
		expect(fenceRunnerEnv()).toEqual({}) // not hosted by Electron ⇒ no ELECTRON_RUN_AS_NODE, even inside Electron
		if (savedNode === undefined) delete process.env.CASCADE_NODE_DIR
		else process.env.CASCADE_NODE_DIR = savedNode
	})
	it('fenceRunnerEnv: ELECTRON_RUN_AS_NODE only when Electron itself hosts the runner (plain node here ⇒ {})', () => {
		expect(fenceRunnerEnv()).toEqual(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
	})
})

describe('selection matrix — platform chain × probe verdicts', () => {
	it('darwin: seatbelt when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'darwin', probeSeatbelt: () => true })).toBe('seatbelt')
		expect(selectLocalBackend({ platform: 'darwin', probeSeatbelt: () => false })).toBe('none')
	})
	it('linux: bwrap when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('bwrap')
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => false })).toBe('none')
	})
	it('win32: selects the fence when its probe passes; a platform with NO chain never spawns a probe', () => {
		expect(selectLocalBackend({ platform: 'win32', probeWinFence: () => true })).toBe('win-write-fence')
		const probeBwrap = vi.fn(() => true)
		const probeSeatbelt = vi.fn(() => true)
		expect(selectLocalBackend({ platform: 'freebsd', probeBwrap, probeSeatbelt })).toBe('none') // no chain
		expect(probeBwrap).not.toHaveBeenCalled()
		expect(probeSeatbelt).not.toHaveBeenCalled()
	})
	it('CASCADE_SANDBOX=off is the kill-switch — none even with a passing probe', () => {
		process.env.CASCADE_SANDBOX = 'off'
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('none')
	})
	it('injected-platform calls never pollute the real-platform cache', () => {
		// A win32 real host would otherwise cache whatever an injected linux probe returned.
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('bwrap')
		const real = selectLocalBackend() // real platform, its own probe; the injected 'bwrap' must not leak
		expect(real).toBe(selectLocalBackend()) // stable/cached
		if (process.platform === 'win32') expect(real).not.toBe('bwrap')
	})
})

describe('confineHostCommand — the HostSandbox entry point', () => {
	it('no policy ⇒ passthrough (the pre-ADR-070 caller is untouched)', () => {
		expect(confineHostCommand('npm test', undefined)).toEqual({ command: 'npm test', backend: 'none' })
	})
	it('danger-full-access ⇒ passthrough (unconfined by definition)', () => {
		expect(confineHostCommand('npm test', { mode: 'danger-full-access', workspaceRoot: ws })).toEqual({ command: 'npm test', backend: 'none' })
	})
	it('a confined policy on a probing platform wraps and carries the backend claims', () => {
		const c = confineHostCommand('npm test', wsWrite, { platform: 'linux', probeBwrap: () => true })
		expect(c.backend).toBe('bwrap')
		expect(c.command.startsWith("'bwrap' ")).toBe(true)
		expect(c.enforcement).toBe('full')
		expect(c.denialSignatures).toContain('read-only file system')
	})
})

describe('HostSandbox integration (this host)', () => {
	it('a policy-carrying exec still runs on a platform with no backend (visible downgrade, not a break)', async () => {
		const host = new HostSandbox(ws)
		const res = await host.exec('echo confined-path-ok', { policy: readOnly })
		expect(res.exitCode).toBe(0)
		expect(res.output).toContain('confined-path-ok')
	})
	it('claims are consistent with the selected backend — present iff a backend confines, never a false promise', () => {
		const host = new HostSandbox(ws)
		const backend = selectLocalBackend()
		if (backend === 'none') {
			expect(host.enforcement).toBeUndefined()
			expect(host.denialSignatures).toBeUndefined()
		} else {
			// win32 today: the fence → 'partial' (writes only). bwrap/seatbelt → 'full'. Never absent when
			// a backend was selected, and never claiming more than the backend delivers.
			expect(host.enforcement).toBe(backend === 'win-write-fence' ? 'partial' : 'full')
			expect(host.denialSignatures?.length).toBeGreaterThan(0)
		}
	})
})
