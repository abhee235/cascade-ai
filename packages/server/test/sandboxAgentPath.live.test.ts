// sandboxAgentPath.live.test.ts — ADR-070 the AGENT-FACING path (Windows, real FFI, no admin).
//
// winFence.live proves the kernel enforces via HostSandbox.exec. This proves the layer the MODEL actually
// touches: BashTool.call → ctx.sandbox.exec(policy) → the fence → the tool's denial classification +
// escalation-hint append. What a weak model recovers from is this text, so it is worth a test of its own.
// Auto-gated on win32 + a passing fence probe; a visible skip elsewhere.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BashTool } from '../../core/src/tools/builtins/Bash.js'
import type { ToolContext } from '../../core/src/tools/Tool.js'
import type { SandboxMode } from '@cascade/core'
import { HostSandbox } from '../src/hostSandbox.js'
import { selectLocalBackend } from '../src/sandboxBackends.js'

const fenceUsable = process.platform === 'win32' && selectLocalBackend() === 'win-write-fence'

async function bash(ws: string, command: string, mode: SandboxMode) {
	const ctx = { cwd: ws, abortSignal: new AbortController().signal, sandbox: new HostSandbox(ws), sandboxPolicy: { mode, workspaceRoot: ws } } as unknown as ToolContext
	return BashTool.call({ command } as never, ctx, () => {})
}

describe.runIf(fenceUsable)('live: the agent-facing Bash → fence path', () => {
	it('workspace-write: a mkdir INSIDE the workspace is allowed', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'agentpath-'))
		try {
			const res = await bash(ws, `mkdir ${JSON.stringify(join(ws, 'inside'))}`, 'workspace-write')
			expect(res.isError).toBeFalsy()
			expect(existsSync(join(ws, 'inside'))).toBe(true)
		} finally {
			rmSync(ws, { recursive: true, force: true })
		}
	})

	it('workspace-write: a mkdir OUTSIDE is denied at the kernel, with the model-facing marker + escalation hint', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'agentpath-'))
		const outside = join(tmpdir(), `escape-${Date.now()}`)
		try {
			const res = await bash(ws, `mkdir ${JSON.stringify(outside)}`, 'workspace-write')
			expect(res.isError).toBe(true)
			expect(res.content).toContain('[sandbox: file access denied under workspace-write mode]')
			expect(res.content).toContain('[sandbox: escalation available')
			expect(existsSync(outside)).toBe(false)
		} finally {
			rmSync(ws, { recursive: true, force: true })
			rmSync(outside, { recursive: true, force: true })
		}
	})

	it('read-only: a mutating command is denied before spawn, with the marker + hint; a pure read still runs', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'agentpath-'))
		try {
			const denied = await bash(ws, `mkdir ${JSON.stringify(join(ws, 'ro'))}`, 'read-only')
			expect(denied.isError).toBe(true)
			expect(denied.content).toContain('[sandbox: file access denied under read-only mode]')
			expect(denied.content).toContain('[sandbox: escalation available')
			expect(existsSync(join(ws, 'ro'))).toBe(false)

			const read = await bash(ws, 'echo just-reading', 'read-only')
			expect(read.isError).toBeFalsy()
			expect(read.content).toContain('just-reading')
		} finally {
			rmSync(ws, { recursive: true, force: true })
		}
	})
})

describe.runIf(!fenceUsable)('live agent-path suite', () => {
	it.skip('requires Windows + a usable write-fence (auto-gated)', () => {})
})
