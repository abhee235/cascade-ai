// sandboxBackends.live.test.ts — ADR-070 step 4 KERNEL-LEVEL verification (Linux + bwrap required).
//
// Runs only on Linux with bubblewrap installed (e.g. inside WSL: `sudo apt install bubblewrap`, then
// `npx vitest run packages/server/test/sandboxBackends.live.test.ts`). Gated by platform + a real
// probe rather than an env flag: on any other machine the whole file is a skip, same pattern as
// dockerSandbox.live.test.ts. What it pins is the ADR's done-when: a write INSIDE the workspace
// succeeds under workspace-write, a write OUTSIDE is denied BY THE KERNEL with the exact stderr
// dialect our denialSignatures classify, and read-only denies everywhere.
import { describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SandboxPolicy } from '@cascade/core'
import { confineHostCommand, selectLocalBackend } from '../src/sandboxBackends.js'

const run = promisify(execFile)

const bwrapUsable = process.platform === 'linux' && spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0

describe.runIf(bwrapUsable)('live: bwrap enforces the policy at the kernel', () => {
	const ws = mkdtempSync(join(tmpdir(), 'bwrap-live-'))
	const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }
	const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws }

	/** Run one confined command through /bin/sh exactly the way HostSandbox's run() does. */
	const sh = async (command: string, policy: SandboxPolicy) => {
		const confined = confineHostCommand(command, policy)
		expect(confined.backend).toBe('bwrap') // the point of the live gate — no silent 'none' pass
		try {
			const { stdout, stderr } = await run('/bin/sh', ['-c', confined.command])
			return { output: stdout + stderr, exitCode: 0, confined }
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; code?: number }
			return { output: `${err.stdout ?? ''}${err.stderr ?? ''}`, exitCode: err.code ?? 1, confined }
		}
	}

	it('selects bwrap on this machine', () => {
		expect(selectLocalBackend()).toBe('bwrap')
	})

	it('workspace-write: a write INSIDE the workspace succeeds', async () => {
		const r = await sh(`touch ${ws}/inside.txt && echo wrote`, wsWrite)
		expect(r.exitCode, r.output).toBe(0)
		expect(existsSync(join(ws, 'inside.txt'))).toBe(true) // and it landed on the REAL fs (bind, not tmpfs)
	})

	it('workspace-write: a write OUTSIDE is denied by the kernel, speaking our denial dialect', async () => {
		const r = await sh('touch /usr/denied.txt', wsWrite)
		expect(r.exitCode).not.toBe(0)
		const low = r.output.toLowerCase()
		expect(r.confined.denialSignatures!.some((s) => low.includes(s))).toBe(true)
		expect(existsSync('/usr/denied.txt')).toBe(false)
	})

	it('read-only: even a workspace write is denied', async () => {
		const r = await sh(`touch ${ws}/ro.txt`, readOnly)
		expect(r.exitCode).not.toBe(0)
		expect(existsSync(join(ws, 'ro.txt'))).toBe(false)
	})
})

// A visible reminder in every non-Linux run that the kernel tests exist and where they run.
describe.runIf(!bwrapUsable)('live bwrap suite', () => {
	it.skip('requires Linux + bubblewrap (run inside WSL after `sudo apt install bubblewrap`)', () => {})
})
