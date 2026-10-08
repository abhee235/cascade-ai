// ADR-081 §4 — the HOST runtime, which is the DEFAULT one, so these paths run on every fresh install.
//
// The interesting cases are the ones where the host cannot simply copy what the container does: it has no
// POSIX shell to lean on, it shares a machine with the user's own processes, and its dev server picks a port
// nobody published for it.

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostSandbox, hostBashPath, sweepHostDevServers, systemInstallRefusal } from '../src/hostSandbox'
import { resetToolchainCache } from '../src/toolchains'
import { devServerError } from '../src/previewManager'

const project = () => mkdtempSync(join(tmpdir(), 'cascade-host-'))
const isWindows = process.platform === 'win32'

/** A real listening process standing in for a dev server; `extra` lands in its command line. */
async function listener(extra: string[] = []) {
	const script = "require('net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"
	const child = spawn(process.execPath, ['-e', script, ...extra], { detached: !isWindows, stdio: ['ignore', 'pipe', 'ignore'] })
	const port = await new Promise<number>((r) => child.stdout!.once('data', (d) => r(Number(String(d).trim()))))
	const exited = new Promise<void>((r) => child.once('exit', () => r()))
	const within = (ms: number) => Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('the dev server is still running')), ms))])
	return { child, port, within, alive: () => child.exitCode === null && child.signalCode === null }
}

describe('HostSandbox', () => {
	it('reports the shell run() actually spawns, so the loop advertises the right syntax', () => {
		// Two measured bugs bracket this: agentLoop once inferred "sandbox ⇒ posix" while commands hit
		// cmd.exe (`mkdir -p` failed on turn 1); then advertising cmd honestly ALSO failed (dokar-9B:
		// 19/25 Bash calls lost to dialect chaos). The contract now: Git Bash when found → posix,
		// cmd.exe fallback → win32 — advertisement and execution always agree.
		const s = new HostSandbox(project())
		expect(s.shell).toBe(isWindows && !hostBashPath ? 'win32' : 'posix')
		expect(s.kind).toBe('host')
	})

	it.runIf(isWindows && !!hostBashPath)('Git Bash executes MULTI-LINE commands fully (cmd stopped at line 1 and exited 0)', async () => {
		// The dokar-9B "cleanup that never happened": cmd ran only the first line of a multi-line command
		// and still exited 0, so the model believed four files were deleted when none were.
		const s = new HostSandbox(project())
		const res = await s.exec('echo first\necho second')
		expect(res.output).toContain('first')
		expect(res.output).toContain('second')
		expect(res.exitCode).toBe(0)
	})

	it.runIf(isWindows && !!hostBashPath)('Git Bash gives POSIX semantics on Windows (the dialect the tool name promises)', async () => {
		const dir = project()
		const s = new HostSandbox(dir)
		const res = await s.exec('mkdir -p nested/deep && ls nested')
		expect(res.exitCode).toBe(0)
		expect(res.output).toContain('deep')
		expect(existsSync(join(dir, 'nested', 'deep'))).toBe(true)
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

	it('actually ENDS a recorded dev server (through Git Bash, `taskkill /PID` became a path and never ran)', async () => {
		// Measured (ADR-086 P0): run() spawns shell strings through Git Bash when it exists, whose path conversion
		// turned `/PID` into `C:/Program Files/Git/PID` — taskkill refused every call, so no dev server was ever
		// stopped (project close, preview restart, the startup sweep). The reclaim test above records a dead pid
		// and cannot see that; this one ends a real process.
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		// Its command line names the project, as a real dev tree's vite does (`<dir>\node_modules\…\vite.js`).
		const dev = await listener([dir])
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: dev.child.pid, port: dev.port }))
		try {
			await new HostSandbox(dir).stopDev()
			await dev.within(4_000)
		} finally {
			if (dev.alive()) dev.child.kill() // never leak it from a failing run
		}
	}, 15_000)

	it.runIf(isWindows)('never force-kills a recorded pid that now belongs to a STRANGER, even while the port is held', async () => {
		// Review (2026-10-04): after a reboot the recorded pid can be reused by an unrelated process, and "something
		// listens on the recorded port" is no proof the pid is ours — `/T /F` would take the stranger's whole tree.
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		const stranger = await listener() // its command line does not name the project
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: stranger.child.pid, port: stranger.port }))
		try {
			await new HostSandbox(dir).stopDev()
			await new Promise((r) => setTimeout(r, 300))
			expect(stranger.alive()).toBe(true)
		} finally {
			if (stranger.alive()) stranger.child.kill()
		}
	}, 15_000)

	it.runIf(isWindows)('reclaims an ORPHANED dev server whose recorded shell died with the old server — by its port', async () => {
		// Node on Windows kills a process's DIRECT children when it exits (the recorded shell), not npm → vite beneath
		// it (measured, ADR-086 P0: five orphaned trees after one bench arm). This listener is that orphaned vite: the
		// recorded pid is dead, and its command line names the project directory, as `<dir>\node_modules\…` does.
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		const dev = await listener([dir])
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: 999_999_999, port: dev.port }))
		try {
			await new HostSandbox(dir).stopDev()
			await dev.within(4_000)
		} finally {
			if (dev.alive()) dev.child.kill()
		}
	}, 15_000)

	it.runIf(isWindows)('never ends a stranger that took the recorded port — its command line does not name the project', async () => {
		const dir = project()
		mkdirSync(join(dir, '.cascade'), { recursive: true })
		const stranger = await listener()
		writeFileSync(join(dir, '.cascade', 'dev.json'), JSON.stringify({ pid: 999_999_999, port: stranger.port }))
		try {
			await new HostSandbox(dir).stopDev()
			await new Promise((r) => setTimeout(r, 300))
			expect(stranger.alive()).toBe(true)
		} finally {
			if (stranger.alive()) stranger.child.kill()
		}
	}, 15_000)
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
		// THE hang: a backgrounded grandchild inherits stdout, so waiting for 'close' waits for the
		// grandchild. Settling on 'exit' returns as soon as the shell itself is done. The grandchild here
		// outlives the call by design — exactly like a detached dev server. The reproduction must speak
		// the dialect run() actually spawns: `&` under Git Bash, `start /b` under the cmd fallback.
		if (!isWindows) return // ping -n is the Windows flavor; POSIX hosts exercise this path in CI Linux runs
		const s = new HostSandbox(project())
		const t0 = Date.now()
		const res = await s.exec(hostBashPath ? 'ping -n 6 127.0.0.1 > /dev/null 2>&1 &' : 'start /b cmd /c "ping -n 6 127.0.0.1 > nul"')
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

describe('sweepHostDevServers — startup reclaim across ALL projects (measured: 55 orphans)', () => {
	it('handles every recorded dev server under the root and clears stale records', async () => {
		const root = mkdtempSync(join(tmpdir(), 'cascade-sweep-'))
		// Project A: a stale record — pid long gone, port not listening. stopDev's pid-reuse guard means
		// nothing gets killed, but the record must be handled and removed.
		mkdirSync(join(root, 'proj-a', '.cascade'), { recursive: true })
		writeFileSync(join(root, 'proj-a', '.cascade', 'dev.json'), JSON.stringify({ pid: 999999, port: 59998 }))
		// Project B: no record — untouched.
		mkdirSync(join(root, 'proj-b'), { recursive: true })

		const swept = await sweepHostDevServers(root)
		expect(swept).toBe(1)
		expect(existsSync(join(root, 'proj-a', '.cascade', 'dev.json'))).toBe(false) // record cleared
	})

	it('a missing projects root sweeps nothing and does not throw', async () => {
		expect(await sweepHostDevServers(join(tmpdir(), 'does-not-exist-' + Date.now()))).toBe(0)
	})
})

// ADR-088 §3 — measured on the v0.1.0 VM: an unprompted `winget install … --accept-package-agreements`.
describe('systemInstallRefusal — no machine-wide installs from host mode', () => {
	it.each([
		'winget install --id OpenJS.NodeJS.LTS --silent',
		'winget.exe list',
		'mkdir x && choco install python',
		'cd app; sudo apt-get install -y ffmpeg',
		'brew install go',
		'msiexec /i node.msi /qn',
		'powershell -NoProfile -Command "winget install Python.Python.3.12"',
		'echo a | scoop install nodejs',
	])('refuses %s', (cmd) => {
		expect(systemInstallRefusal(cmd)).toMatch(/mise\.toml/)
	})
	it.each(['npm install', 'pip install requests', 'npx tsc --noEmit', 'grep -r apt src', 'echo "adapter" && node brewery.js', 'git commit -m "fix sudoku"'])(
		'allows %s',
		(cmd) => {
			expect(systemInstallRefusal(cmd)).toBeUndefined()
		},
	)
	it('exec returns the refusal without running anything', async () => {
		const dir = project()
		const res = await new HostSandbox(dir).exec('winget install foo && echo ran > ran.txt')
		expect(res.exitCode).toBe(1)
		expect(res.output).toMatch(/^Refused: system package managers/)
		expect(existsSync(join(dir, 'ran.txt'))).toBe(false)
	})
})

// ADR-088 §2 — the product provisions mise.toml, unconfined, once per change. The stand-in "mise" is a copy of
// node: `mise install` then runs node on a missing script and exits non-zero, so each provision attempt is
// visible as the failure note, and a skipped one as its absence.
describe('exec provisions an edited mise.toml before the command', () => {
	it('runs mise install only when mise.toml changed', async () => {
		const saved = process.env.CASCADE_MISE_PATH
		const bin = mkdtempSync(join(tmpdir(), 'cascade-fakemise-'))
		const fake = join(bin, isWindows ? 'mise.exe' : 'mise')
		copyFileSync(process.execPath, fake)
		process.env.CASCADE_MISE_PATH = fake
		resetToolchainCache()
		try {
			const dir = project()
			const sb = new HostSandbox(dir)
			expect((await sb.exec('echo one')).output).not.toMatch(/mise install/) // no mise.toml ⇒ nothing to do
			writeFileSync(join(dir, 'mise.toml'), '[tools]\npython = "3.12"\n')
			expect((await sb.exec('echo two')).output).toMatch(/could not install the toolchains/)
			const third = await sb.exec('echo three')
			expect(third.output).not.toMatch(/could not install/) // unchanged ⇒ one stat, no provision
			expect(third.output).toMatch(/three/)
			writeFileSync(join(dir, 'mise.toml'), '[tools]\npython = "3.13"\ngo = "1.23"\n')
			expect((await sb.exec('echo four')).output).toMatch(/could not install the toolchains/)
		} finally {
			if (saved === undefined) delete process.env.CASCADE_MISE_PATH
			else process.env.CASCADE_MISE_PATH = saved
			resetToolchainCache()
		}
	}, 60_000)
})

// ADR-088 §5 — what the v0.1.0 VM agent had to discover by trial: the shell, the node it gets, the preview port.
describe('environmentFacts — stated, not discovered', () => {
	it('names the shell, the toolchain and (once reserved) the preview port, and stays stable', async () => {
		const sb = new HostSandbox(project())
		const before = sb.environmentFacts
		expect(before[0]).toMatch(/^Shell: Bash runs /)
		expect(before[1]).toMatch(/^Toolchain: node v\d+.* and npm \d/) // the test runner's own node is on PATH
		expect(before.some((l) => l.startsWith('Preview:'))).toBe(false)
		expect(sb.environmentFacts).toBe(before) // cached: same array, no re-probe
		const port = await sb.previewPort()
		expect(sb.environmentFacts.at(-1)).toBe(`Preview: the Preview pane serves the dev server at http://localhost:${port} — that is the app's port, whatever package.json says.`)
	}, 30_000)
})

// ADR-089 §1 — the v0.1.0 VM: no npm, the launch shell died in under a second, the callers waited 30–60 s.
describe('devExited — a failed launch is visible at once', () => {
	it('turns true when npm cannot be found', async () => {
		const sb = new HostSandbox(project())
		writeFileSync(join(sb.root, 'package.json'), '{"scripts":{"dev":"vite"}}')
		await sb.startDev({ PATH: mkdtempSync(join(tmpdir(), 'empty-path-')) })
		const t0 = Date.now()
		while (!sb.devExited() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100))
		expect(sb.devExited()).toBe(true)
		expect(await sb.devLog(5)).toMatch(/not recognized|not found/i)
		await sb.stopDev()
	}, 20_000)
})
