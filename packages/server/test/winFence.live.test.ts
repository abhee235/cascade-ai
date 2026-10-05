// winFence.live.test.ts — ADR-070 step 6 / ADR-087 KERNEL-LEVEL verification (Windows only, real FFI, no admin).
//
// Auto-gated on win32 + a passing fence probe (same pattern as the bwrap live suite) — a visible skip
// everywhere else. Pins the done-when: the fence DENIES a write outside the workspace and under read-only,
// ALLOWS a write inside a labeled workspace (including a tree that existed before the label), lets a
// workspace-write child spawn grandchildren with PIPED stdio (esbuild, node — the build), and the denial
// speaks the dialect our denialSignatures classify. Exercises the FFI directly AND the full HostSandbox.exec path.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPolicy } from '@cascade/core'
import { buildRestrictedToken, hasLowLabel, labelLowIntegrity, spawnUnderToken, unlabelLowIntegrity } from '../src/winFence.js'
import { HostSandbox } from '../src/hostSandbox.js'
import { selectLocalBackend, sweepWorkspaceLabels } from '../src/sandboxBackends.js'

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

	it('workspace-write ALLOWS inside the labeled workspace and DENIES outside', () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-ws-'))
		const outside = mkdtempSync(join(tmpdir(), 'fence-out-'))
		labelLowIntegrity(ws)
		const inside = join(ws, 'ok.txt')
		const escape = join(outside, 'escape.txt')
		expect(spawnUnderToken(buildRestrictedToken({ mode: 'workspace-write' }).token, `${cmd} /d /s /c "echo x > ${inside}"`, ws)).toBe(0)
		expect(existsSync(inside)).toBe(true)
		expect(spawnUnderToken(buildRestrictedToken({ mode: 'workspace-write' }).token, `${cmd} /d /s /c "echo x > ${escape}"`, ws)).not.toBe(0)
		expect(existsSync(escape)).toBe(false)
		rmSync(ws, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})

	it('the label reaches a tree that existed BEFORE it (a real project), and stands — a second call is a no-op', () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-tree-'))
		mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
		writeFileSync(join(ws, 'src', 'deep', 'old.txt'), 'before')
		expect(hasLowLabel(ws)).toBe(false)
		labelLowIntegrity(ws)
		expect(hasLowLabel(ws)).toBe(true)
		labelLowIntegrity(ws) // stands: finds the label on the root, skips the walk
		const token = buildRestrictedToken({ mode: 'workspace-write' }).token
		const deep = join(ws, 'src', 'deep')
		expect(spawnUnderToken(token, `${cmd} /d /s /c "echo after> ${join(deep, 'old.txt')} && echo x> ${join(deep, 'new.txt')}"`, ws)).toBe(0)
		expect(readFileSync(join(deep, 'old.txt'), 'utf8').trim()).toBe('after')
		expect(existsSync(join(deep, 'new.txt'))).toBe(true)
		rmSync(ws, { recursive: true, force: true })
	})

	it('workspace-write: a child spawns grandchildren with PIPED stdio — esbuild and node (the build); read-only still cannot', () => {
		// The measured 2026-09-29 failure: every piped spawn under the WRITE_RESTRICTED token was `spawn EPERM`
		// (node's stdio pipes are named pipes whose default DACL no restricting SID could write) — so `vite build`
		// could never run inside the fence. esbuild's service is exactly such a spawn.
		const ws = mkdtempSync(join(tmpdir(), 'fence-pipe-'))
		labelLowIntegrity(ws)
		const esbuild = createRequire(import.meta.url).resolve('esbuild').replaceAll('\\', '/')
		writeFileSync(
			join(ws, 'probe.cjs'),
			[
				"const { spawnSync } = require('node:child_process')",
				"const r = spawnSync(process.execPath, ['-e', '0'], { stdio: 'pipe', windowsHide: true })",
				'if (r.error || r.status !== 0) process.exit(3)',
				`require('${esbuild}').build({ stdin: { contents: 'export const a = 1' }, write: false }).then(() => process.exit(0), () => process.exit(4))`,
			].join('\n'),
		)
		const run = (mode: 'read-only' | 'workspace-write') => spawnUnderToken(buildRestrictedToken({ mode }).token, `${cmd} /d /s /c ""${process.execPath}" probe.cjs"`, ws)
		expect(run('workspace-write')).toBe(0)
		expect(run('read-only')).not.toBe(0) // the documented read-only boundary (ADR-087): no build runs there
		rmSync(ws, { recursive: true, force: true })
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

	it('taking the label off revokes writes — even to a file the low child created while it held the label', () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-unlabel-'))
		labelLowIntegrity(ws)
		const token = () => buildRestrictedToken({ mode: 'workspace-write' }).token
		const own = join(ws, 'sub', 'own.txt')
		expect(spawnUnderToken(token(), `${cmd} /d /s /c "mkdir ${join(ws, 'sub')} && echo a> ${own}"`, ws)).toBe(0)
		unlabelLowIntegrity(ws)
		expect(hasLowLabel(ws)).toBe(false)
		expect(spawnUnderToken(token(), `${cmd} /d /s /c "echo b> ${own}"`, ws)).not.toBe(0)
		expect(readFileSync(own, 'utf8').trim()).toBe('a')
		writeFileSync(join(ws, 'sub', 'server.txt'), 'the server (medium integrity) still writes') // labels never bind it
		rmSync(ws, { recursive: true, force: true })
	})

	it('a CLOSED project is not writable to another project — the last sandbox out takes the label off (ADR-087 amendment)', async () => {
		const a = mkdtempSync(join(tmpdir(), 'fence-proj-a-'))
		const b = mkdtempSync(join(tmpdir(), 'fence-proj-b-'))
		const policy = (ws: string): SandboxPolicy => ({ mode: 'workspace-write', workspaceRoot: ws })
		const hostA1 = new HostSandbox(a)
		const hostA2 = new HostSandbox(a) // a second session on the same project
		const hostB = new HostSandbox(b)
		expect((await hostA1.exec('echo 1> one.txt', { policy: policy(a) })).exitCode).toBe(0)
		expect((await hostA2.exec('echo 2> two.txt', { policy: policy(a) })).exitCode).toBe(0)
		expect((await hostB.exec('echo b> b.txt', { policy: policy(b) })).exitCode).toBe(0)
		await hostA1.dispose()
		expect(hasLowLabel(a)).toBe(true) // A2 still holds it
		await hostA2.dispose()
		expect(hasLowLabel(a)).toBe(false) // closed
		// Project B's fenced command can no longer write closed project A.
		const intoA = await hostB.exec(`echo x > ${join(a, 'from-b.txt')}`, { policy: policy(b) })
		expect(intoA.exitCode).not.toBe(0)
		expect(existsSync(join(a, 'from-b.txt'))).toBe(false)
		await hostB.dispose()
		rmSync(a, { recursive: true, force: true })
		rmSync(b, { recursive: true, force: true })
	})

	it('the startup sweep takes off labels a crashed run left behind', () => {
		const root = mkdtempSync(join(tmpdir(), 'fence-root-'))
		const stale = join(root, 'proj-1')
		mkdirSync(stale)
		labelLowIntegrity(stale) // as if the previous server died before disposing its sandboxes
		mkdirSync(join(root, 'proj-2')) // never labeled
		expect(sweepWorkspaceLabels(root)).toBe(1)
		expect(hasLowLabel(stale)).toBe(false)
		rmSync(root, { recursive: true, force: true })
	})

	it("end-to-end: a workspace-write denial outside speaks the dialect — cmd's and node's alike (ADR-087)", async () => {
		const ws = mkdtempSync(join(tmpdir(), 'fence-hostd-'))
		const outside = mkdtempSync(join(tmpdir(), 'fence-outd-'))
		const host = new HostSandbox(ws)
		const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }
		const classified = (out: string) => (host.denialSignatures ?? []).some((s) => out.toLowerCase().includes(s))
		const viaCmd = await host.exec(`echo x > ${join(outside, 'a.txt')}`, { policy })
		expect(viaCmd.exitCode).not.toBe(0)
		expect(classified(viaCmd.output), viaCmd.output).toBe(true)
		// node reports a denied write as "EPERM: operation not permitted" — unclassified before ADR-087.
		const target = join(outside, 'b.txt').replaceAll('\\', '/')
		const viaNode = await host.exec(`node -e "require('fs').writeFileSync('${target}', 'x')"`, { policy })
		expect(viaNode.exitCode).not.toBe(0)
		expect(classified(viaNode.output), viaNode.output).toBe(true)
		expect(existsSync(join(outside, 'a.txt')) || existsSync(join(outside, 'b.txt'))).toBe(false)
		rmSync(ws, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})
})

describe.runIf(!fenceUsable)('live write-fence suite', () => {
	it.skip('requires Windows (restricted-token write-fence; auto-gated)', () => {})
})
