// MEASURED HANG (2026-07-30, FocusFlow run): the model started a dev server detached —
// `start /b cmd /c "npx vite --host 127.0.0.1" > focusflow.log 2>&1`. The grandchild inherited the shell's
// stdout/stderr pipes, so Node's 'close' (process exited AND all stdio ended) never fired, and the
// timeout's abort killed only the direct shell. The tool call hung for 37+ MINUTES on a 120s deadline —
// the whole turn was stuck with the dev server happily running on :5173.
//
// The tool now settles on 'exit' and has a deadline that resolves the call itself + kills the tree.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BashTool } from '../src/tools/builtins/Bash'

const ctx = { cwd: process.cwd(), abortSignal: new AbortController().signal } as never
const run = (command: string, timeout?: number) => BashTool.call({ command, timeout } as never, ctx)

describe('Bash — a detached child must not hang the turn', () => {
	it(
		'returns promptly when the command spawns a process that OUTLIVES the shell and holds the pipes',
		async () => {
			// A grandchild that keeps stdout open for 60s while the shell itself exits immediately — the
			// portable shape of `start /b …` / `nohup … &`.
			const cmd =
				process.platform === 'win32'
					? 'start /b cmd /c "node -e \\"setTimeout(()=>{},60000)\\""'
					: 'node -e "setTimeout(()=>{},60000)" & disown 2>/dev/null || node -e "setTimeout(()=>{},60000)" &'
			const t0 = Date.now()
			const r = await run(cmd, 5000)
			const elapsed = Date.now() - t0
			// Before the fix this never resolved (test would time out). Allow the 5s deadline + slack.
			expect(elapsed).toBeLessThan(9000)
			expect(typeof r.content).toBe('string')
		},
		20_000,
	)

	it('an ordinary command still returns its output and exit code', async () => {
		const r = await run(process.platform === 'win32' ? 'echo hello-cascade' : 'echo hello-cascade')
		expect(r.content).toContain('hello-cascade')
		expect(r.isError).toBeFalsy()
	})

	it('a hanging FOREGROUND command still hits the deadline and reports it', async () => {
		const cmd = process.platform === 'win32' ? 'node -e "setTimeout(()=>{},30000)"' : 'sleep 30'
		const t0 = Date.now()
		const r = await run(cmd, 1500)
		expect(Date.now() - t0).toBeLessThan(6000)
		expect(r.isError).toBe(true)
		expect(r.content).toContain('timed out')
	}, 15_000)
})

// ── Shell-authored file content is refused (FocusFlow, 2026-07-30) ───────────────────────────────────
// The model wrote a test file with `echo` and cmd.exe ate every `>` — `() =>` arrived as `() =`. Vitest
// then reported "No test suite found", and 20 turns went into rewriting a vitest config that was fine.
describe('Bash — refuses to author file CONTENT through the shell', () => {
	it('blocks echo/printf/cat redirects into source files, naming the right tool', async () => {
		for (const cmd of [
			'echo "const a = () => 1" > src/a.ts',
			"printf '%s' '{}' > tsconfig.json",
			'cd app && echo hi >> src/notes.md',
			'cat > src/b.tsx << EOF',
		]) {
			const r = await run(cmd)
			expect(r.isError, cmd).toBe(true)
			expect(r.content, cmd).toContain('Write')
		}
	})

	it('does NOT block redirecting command OUTPUT to a log, or plain echo', async () => {
		// Redirect into a TEMP dir — a test must never write into the repo it is testing.
		const dir = mkdtempSync(join(tmpdir(), 'bash-log-'))
		const log = await BashTool.call({ command: `echo build-ok > ${join(dir, 'build.log').replace(/\\/g, '/')}` } as never, {
			cwd: dir,
			abortSignal: new AbortController().signal,
		} as never)
		expect(log.isError).toBeFalsy() // .log is not a source file
		rmSync(dir, { recursive: true, force: true })
		const plain = await run('echo just-printing')
		expect(plain.content).toContain('just-printing')
	})
})

// ── Broad process kills are refused (3D Solar build, 2026-08-03) ─────────────────────────────────────
// Believing a stale HMR cache, the model ran 24 kill/nuke commands over 32 minutes — `pkill -f vite`
// escalating to `pkill -9 node` / `killall node`, which killed the dev server behind the preview proxy
// ("Preview unreachable"). A prose ban existed but named only `pkill -f node`; the model used other spellings.
describe('Bash — refuses broad process killing', () => {
	it('blocks the whole family, however it is spelled', async () => {
		for (const cmd of [
			'pkill -f vite',
			'pkill -9 node',
			'killall node',
			'cd /workspace && pkill -9 -f "node.*5173" 2>/dev/null',
			'kill $(lsof -t -i:5173)',
			'kill $(pgrep -f vite)',
			'rm -rf .vite; killall -9 node',
		]) {
			const r = await run(cmd)
			expect(r.isError, cmd).toBe(true)
			expect(r.content, cmd).toContain('dev server')
		}
	})

	it('leaves legitimate commands alone (including cache clearing without a kill)', async () => {
		const ok = await run('echo skipping-kill')
		expect(ok.isError).toBeFalsy()
		expect(ok.content).toContain('skipping-kill')
	})
})
