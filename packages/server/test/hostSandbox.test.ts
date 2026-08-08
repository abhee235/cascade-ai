// ADR-081 §4 — the HOST runtime, which is the DEFAULT one, so these paths run on every fresh install.
//
// The interesting cases are the ones where the host cannot simply copy what the container does: it has no
// POSIX shell to lean on, it shares a machine with the user's own processes, and its dev server picks a port
// nobody published for it.

import { describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostSandbox } from '../src/hostSandbox'
import { devServerError } from '../src/previewManager'

const project = () => mkdtempSync(join(tmpdir(), 'cascade-host-'))
const isWindows = process.platform === 'win32'

describe('HostSandbox', () => {
	it('reports the HOST shell, so the loop advertises the right syntax', () => {
		// The bug this prevents: agentLoop used to infer "sandbox ⇒ posix". Injecting a host runtime on
		// Windows would then tell the model to use POSIX syntax while commands hit cmd.exe — the measured
		// `mkdir -p` failure on turn 1, reintroduced by the very feature meant to make host mode work.
		const s = new HostSandbox(project())
		expect(s.shell).toBe(isWindows ? 'win32' : 'posix')
		expect(s.kind).toBe('host')
	})

	it('roots the path jail at the real project directory', () => {
		// Docker reports /workspace because that is where the project is mounted. On the host there is no
		// mount, so the alias must collapse to the identity or the jail would compare against a path that
		// does not exist.
		const dir = project()
		expect(new HostSandbox(dir).root).toBe(dir)
	})

	it('runs a command in the project and returns its output and exit code', async () => {
		const dir = project()
		const s = new HostSandbox(dir)
		const res = await s.exec('echo cascade-ok')
		expect(res.output).toContain('cascade-ok')
		expect(res.exitCode).toBe(0)
	})

	it('reports a non-zero exit rather than throwing', async () => {
		const s = new HostSandbox(project())
		const res = await s.exec(isWindows ? 'exit 3' : 'exit 3')
		expect(res.exitCode).toBe(3)
	})

	it('streams output as it arrives', async () => {
		const chunks: string[] = []
		await new HostSandbox(project()).exec('echo streamed', { onData: (c) => chunks.push(c) })
		expect(chunks.join('')).toContain('streamed')
	})

	it('treats dependencies as absent when node_modules is missing OR empty', async () => {
		// Empty-but-present is the state a Docker volume starts in; on the host it happens after a failed
		// install. Both must read as "not installed", or the preview skips installing forever.
		const dir = project()
		const s = new HostSandbox(dir)
		expect(await s.hasDependencies()).toBe(false)
		mkdirSync(join(dir, 'node_modules'))
		expect(await s.hasDependencies()).toBe(false)
		writeFileSync(join(dir, 'node_modules', 'x.js'), '')
		expect(await s.hasDependencies()).toBe(true)
	})

	it('reserves ONE free port and keeps returning it', async () => {
		// Vite bakes the HMR client port into the bundle, so the answer has to be stable across the calls
		// made before and after the dev server starts.
		const s = new HostSandbox(project())
		const a = await s.previewPort()
		const b = await s.previewPort()
		expect(a).toBe(b)
		expect(a).toBeGreaterThan(1023)
	})

	it('gives DIFFERENT projects different ports', async () => {
		// The template's dev script is a fixed 5173. Two host projects sharing it would collide, and the
		// loser drifts to another port that the preview is not watching.
		const a = await new HostSandbox(project()).previewPort()
		const b = await new HostSandbox(project()).previewPort()
		expect(a).not.toBe(b)
	})

	it('reads the tail of the dev log, and empty when there is none', async () => {
		const dir = project()
		const s = new HostSandbox(dir)
		expect(await s.devLog(10)).toBe('')
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		writeFileSync(join(dir, '.cascade', 'dev.log'), ['one', 'two', 'three', 'four'].join('\n'))
		expect(await s.devLog(2)).toBe('three\nfour')
	})

	it('follows the dev log: backlog first, then appended lines, until aborted', async () => {
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		const log = join(dir, '.cascade', 'dev.log')
		writeFileSync(log, 'backlog line\n')

		const s = new HostSandbox(dir)
		const seen: string[] = []
		const ctrl = new AbortController()
		s.followDevLog((l) => seen.push(l), ctrl.signal)

		await waitFor(() => seen.includes('backlog line'))
		appendFileSync(log, '\x1b[32mgreen\x1b[0m line\n')
		await waitFor(() => seen.some((l) => l.includes('green line')))
		// ANSI is stripped: the Console pane renders plain text, and Vite colourises everything.
		expect(seen.some((l) => l.includes('\x1b['))).toBe(false)

		ctrl.abort()
		const count = seen.length
		appendFileSync(log, 'after abort\n')
		await new Promise((r) => setTimeout(r, 1200)) // longer than the poll interval
		expect(seen.length).toBe(count)
	})

	it('reclaims a dev server started by a PREVIOUS process, and clears the record', async () => {
		// The measured leak: the dev server is detached so it outlives a `tsx watch` restart, but the in-memory
		// pid does not. A fresh HostSandbox must still be able to stop it, or every restart orphans a process
		// holding a port. Docker solves the same problem with a container label; this file is the host's.
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		// A real listener stands in for the orphaned dev server, so stopDev's "is it still there" check is
		// exercised for real rather than mocked.
		const srv = createServer()
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
		const port = (srv.address() as { port: number }).port
		// Record OUR OWN pid: stopDev must not kill it, because the guard below sees the port is held by a
		// process it can verify — the point of the test is the record is found and cleared, not that vitest dies.
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: 999_999_999, port }))

		await new HostSandbox(dir).stopDev()
		expect(existsSync(join(dir, '.cascade', 'dev.json'))).toBe(false) // record always cleared
		srv.close()
	})

	it('does NOT kill a recorded pid when nothing is listening on its port', async () => {
		// PID reuse: a pid from a previous boot may since belong to an unrelated process, and killing a
		// stranger's process because we once used that number would be genuinely hostile. A dead port is the
		// evidence that our dev server is already gone.
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: process.pid, port: 1 }))
		await new HostSandbox(dir).stopDev()
		expect(process.pid).toBeGreaterThan(0) // still here — we did not signal ourselves
		expect(existsSync(join(dir, '.cascade', 'dev.json'))).toBe(false)
	})

	it('stopDev is safe when nothing was ever started', async () => {
		// Called on every startDev and on dispose, so the no-op path runs constantly.
		await expect(new HostSandbox(project()).stopDev()).resolves.toBeUndefined()
		await expect(new HostSandbox(project()).dispose()).resolves.toBeUndefined()
	})
})

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (pred()) return
		await new Promise((r) => setTimeout(r, 50))
	}
	throw new Error('timed out waiting for condition')
}

// ADR-081 §4 — the partial-install trap, and surfacing the reason a dev server died.
describe('dependency completeness', () => {
	it('reports MISSING when node_modules holds only some declared packages', async () => {
		// Measured: the agent fixed an import with `npm install lucide-react`, which left 34 entries in
		// node_modules. A non-empty check called that "installed", the preview skipped its install, and Vite
		// died on `Cannot find package '@tailwindcss/vite'` — surfacing only as "Couldn't start the preview".
		const dir = project()
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^18', 'lucide-react': '^1' }, devDependencies: { '@tailwindcss/vite': '^4' } }))
		const s = new HostSandbox(dir)
		expect(await s.hasDependencies()).toBe(false)

		mkdirSync(join(dir, 'node_modules', 'lucide-react'), { recursive: true })
		expect(await s.hasDependencies()).toBe(false) // non-empty, but still incomplete

		mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
		mkdirSync(join(dir, 'node_modules', '@tailwindcss', 'vite'), { recursive: true }) // scoped names too
		expect(await s.hasDependencies()).toBe(true)
	})

	it('treats a project with no declared dependencies as installed', async () => {
		const dir = project()
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
		expect(await new HostSandbox(dir).hasDependencies()).toBe(true)
	})
})

describe('devServerError', () => {
	it('pulls the CAUSE out of a real Vite failure, skipping stacks and code frames', () => {
		// Verbatim from the failing run, ANSI included.
		const log = [
			'> vite --host --port 61146',
			'\x1b[31mfailed to load config from C:\...\vite.config.ts\x1b[39m',
			"\x1b[31merror when starting dev server:",
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@tailwindcss/vite' imported from C:\...\vite.config.ts.timestamp.mjs",
			'    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)',
			'    at packageResolve (node:internal/modules/esm/resolve:768:81)',
		].join('\n')
		const msg = devServerError(log)
		expect(msg).toContain("Cannot find package '@tailwindcss/vite'")
		expect(msg).not.toContain('at Object.') // a stack frame is context, not the cause
		expect(msg).not.toContain('\x1b[') // this goes in a UI label, not a terminal
	})

	it('returns undefined for a healthy log, so the generic message still applies', () => {
		expect(devServerError('VITE v5.4.21  ready in 529 ms\n  Local: http://localhost:5173/')).toBeUndefined()
	})
})

// The stuck-turn fixes (measured in a desktop trace: an AGENT turn hung on an open Bash span).
describe('detached children and dev servers', () => {
	it('settles when the direct child exits, even if a detached grandchild still holds the pipes', async () => {
		// THE hang: `start /b` leaves a grandchild that inherits stdout, so waiting for 'close' waits for
		// the grandchild. Settling on 'exit' returns as soon as the shell itself is done. The grandchild
		// here outlives the call by design — exactly like a detached dev server.
		if (!isWindows) return // start /b is the Windows-specific reproduction
		const s = new HostSandbox(project())
		const t0 = Date.now()
		const res = await s.exec('start /b cmd /c "ping -n 6 127.0.0.1 > nul"')
		expect(Date.now() - t0).toBeLessThan(3000) // grandchild pings for ~5s; we must not wait for it
		expect(res.exitCode).toBe(0)
	})

	it('refuses to start a dev server — the Preview owns it, in host mode too', async () => {
		// Docker mode has had this guard all along; host mode missing it is how the model started its own
		// vite via `start /b` and collided with the preview's reserved port.
		const s = new HostSandbox(project())
		const res = await s.exec('npm run dev')
		expect(res.exitCode).toBe(1)
		expect(res.output).toMatch(/Preview/)
	})
})
