// winFence.live.test.ts — ADR-070 step 6 KERNEL-LEVEL verification (Windows only, real FFI, no admin).
//
// Auto-gated on win32 + a passing fence probe (same pattern as the bwrap live suite) — a visible skip
// everywhere else. Pins the done-when: the restricted token DENIES a write outside the workspace and
// under read-only, ALLOWS a write inside a granted workspace, and the denial speaks the dialect our
// denialSignatures classify. Exercises the FFI directly AND the full HostSandbox.exec path.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPolicy } from '@cascade/core'
import { buildRestrictedToken, grantWriteAce, spawnUnderToken } from '../src/winFence.js'
import { workspaceWriteSid } from '../src/winFenceSid.js'
import { HostSandbox } from '../src/hostSandbox.js'
import { selectLocalBackend } from '../src/sandboxBackends.js'

const cmd = process.env.ComSpec ?? 'cmd.exe'
const fenceUsable = (() => {
	if (process.platform !== 'win32') return false
	try {
		const { token } = buildRestrictedToken({ mode: 'read-only' })
		return spawnUnderToken(token, `${cmd} /d /s /c "exit 0"`, process.cwd()) === 0
	} catch {
		return false
	}
})()

describe.runIf(fenceUsable)('live: the Windows write-fence enforces at the kernel (no admin)', () => {
	it('selects win-write-fence on this machine', () => {
		expect(selectLocalBackend()).toBe('win-write-fence')
	})

	it('read-only DENIES a file write (token restriction, before any grant)', () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-ro-'))
		const target = join(ws, 'x.txt')
		const { token } = buildRestrictedToken({ mode: 'read-only' })
		const code = spawnUnderToken(token, `${cmd} /d /s /c "echo x > ${target}"`, ws)
		expect(code).not.toBe(0)
		expect(existsSync(target)).toBe(false)
		rmSync(ws, { recursive: true, force: true })
	})

	it('workspace-write ALLOWS inside the granted workspace and DENIES outside', () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-ws-'))
		const outside = mkdtempSync(join(tmpdir(), 'fence-out-'))
		const sid = workspaceWriteSid(ws)
		grantWriteAce(ws, sid)
		const inside = join(ws, 'ok.txt')
		const escape = join(outside, 'escape.txt')
		expect(spawnUnderToken(buildRestrictedToken({ mode: 'workspace-write', grants: [{ dir: ws, sid }] }).token, `${cmd} /d /s /c "echo x > ${inside}"`, ws)).toBe(0)
		expect(existsSync(inside)).toBe(true)
		expect(spawnUnderToken(buildRestrictedToken({ mode: 'workspace-write', grants: [{ dir: ws, sid }] }).token, `${cmd} /d /s /c "echo x > ${escape}"`, ws)).not.toBe(0)
		expect(existsSync(escape)).toBe(false)
		rmSync(ws, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})

	it('end-to-end through HostSandbox.exec: read-only policy denies a write, dialect matches denialSignatures', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-host-'))
		const host = new HostSandbox(ws)
		expect(host.enforcement).toBe('partial') // honest claim surfaced to the seam
		const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws }
		const r = await host.exec(`echo x > ${join(ws, 'nope.txt')}`, { policy })
		expect(r.exitCode).not.toBe(0)
		expect(existsSync(join(ws, 'nope.txt'))).toBe(false)
		const low = r.output.toLowerCase()
		expect((host.denialSignatures ?? []).some((s) => low.includes(s))).toBe(true)
		rmSync(ws, { recursive: true, force: true })
	})

	it('end-to-end: workspace-write lets the model write inside, and %TEMP% resolves to the private temp', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-hostw-'))
		const host = new HostSandbox(ws)
		const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }
		const inside = await host.exec(`echo hello > ${join(ws, 'made.txt')}`, { policy })
		expect(inside.exitCode, inside.output).toBe(0)
		expect(existsSync(join(ws, 'made.txt'))).toBe(true)
		// %TEMP% writes must succeed (npm/build tools rely on them) — redirected into the workspace-private temp.
		const tmp = await host.exec(`echo t > %TEMP%\\probe.txt && echo TEMP-OK`, { policy })
		expect(tmp.output).toContain('TEMP-OK')
		rmSync(ws, { recursive: true, force: true })
	})
})

describe.runIf(!fenceUsable)('live write-fence suite', () => {
	it.skip('requires Windows (restricted-token write-fence; auto-gated)', () => {})
})
