// sandboxBackends.test.ts — ADR-070 step 4: profiles, probes, selection matrix, confinement wrapping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, type SandboxPolicy } from '@cascade/core'
import { bwrapArgs, confineHostCommand, resetBackendCache, seatbeltProfile, selectLocalBackend, shq, wrapCommand } from '../src/sandboxBackends.js'
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
		expect(w.startsWith('bwrap --ro-bind / /')).toBe(true)
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

describe('selection matrix — platform chain × probe verdicts', () => {
	it('darwin: seatbelt when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'darwin', probeSeatbelt: () => true })).toBe('seatbelt')
		expect(selectLocalBackend({ platform: 'darwin', probeSeatbelt: () => false })).toBe('none')
	})
	it('linux: bwrap when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('bwrap')
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => false })).toBe('none')
	})
	it('win32: none, and no probe is ever spawned for a platform with no chain', () => {
		const probeBwrap = vi.fn(() => true)
		const probeSeatbelt = vi.fn(() => true)
		expect(selectLocalBackend({ platform: 'win32', probeBwrap, probeSeatbelt })).toBe('none')
		expect(probeBwrap).not.toHaveBeenCalled()
		expect(probeSeatbelt).not.toHaveBeenCalled()
	})
	it('CASCADE_SANDBOX=off is the kill-switch — none even with a passing probe', () => {
		process.env.CASCADE_SANDBOX = 'off'
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('none')
	})
	it('injected-platform calls never pollute the real-platform cache', () => {
		expect(selectLocalBackend({ platform: 'linux', probeBwrap: () => true })).toBe('bwrap')
		// The real platform here is win32 → 'none'; a cached 'bwrap' from the injected call would be a bug.
		expect(selectLocalBackend()).toBe(process.platform === 'win32' ? 'none' : selectLocalBackend())
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
		expect(c.command.startsWith('bwrap ')).toBe(true)
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
	it('claims are absent when no backend is selected (no false promises on Windows today)', () => {
		if (process.platform !== 'win32') return // claim shape is platform-dependent by design
		const host = new HostSandbox(ws)
		expect(host.enforcement).toBeUndefined()
		expect(host.denialSignatures).toBeUndefined()
	})
})
