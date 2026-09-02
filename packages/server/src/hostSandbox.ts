// hostSandbox.ts — run a project's commands as LOCAL child processes (ADR-081 §4).
//
// The default runtime. Requiring Docker is install friction that kills desktop adoption: the app has to be
// useful the moment it is installed, with isolation available to anyone who wants it.
//
// Stated plainly rather than discovered later — the same words as the ADR, because this is the file that
// makes it true: the path jail (`resolveInProject`, ADR-033) constrains FILE tools, not `Bash`. In host
// mode the agent runs `npm install` and generated build scripts directly on the user's machine. That is the
// trade every local developer tool makes for a machine its owner controls; an editor's task runner and its
// extensions have identical reach. Docker mode is the answer for anyone who wants more.
//
// What this deliberately does NOT do is emulate a container. `root` is the real project directory, so the
// path jail's in-sandbox alias collapses to the identity, and `shell` reports the shell run() will actually
// spawn — Git Bash (posix) when it can be found, cmd.exe (win32) as the fallback — so the loop advertises
// the right syntax either way.

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import type { ExecOptions, ExecResult } from '@cascade/core'
import { devServerRefusal } from './dockerSandbox.js'
import { type ProjectRuntime, stripAnsi } from './projectRuntime.js'
import { confineHostCommand, localBackendClaims } from './sandboxBackends.js'
import { ensureProjectToolchainConfig, installProjectToolchains, miseEnv } from './toolchains.js'

/** Where a detached dev server's output goes. Inside the project so it travels with it, and so a user can
 *  open it; `.cascade/` is already this project's scratch area. */
const devLogPath = (dir: string) => join(dir, '.cascade', 'dev.log')

/**
 * The running dev server's pid and port, ON DISK.
 *
 * Not an optimisation — it is what makes stopping one possible at all. The dev server is DETACHED so it
 * survives the request that started it, which means it also survives the server process: a `tsx watch`
 * restart, a crash, or a quit all leave it running and holding its port, with the in-memory pid gone.
 * Measured directly: switching runtime mode after a server restart left vite alive on port 58597 because
 * the fresh HostSandbox had never heard of it.
 *
 * Docker has the same problem and solves it the same way — a container LABEL that `sweepSandboxContainers`
 * finds on the next launch. This file is the host's label.
 */
const devPidPath = (dir: string) => join(dir, '.cascade', 'dev.json')

/** Windows has no POSIX shell GUARANTEE — but one is worth looking for. The original design accepted
 *  cmd.exe and relied on core's Bash tool teaching cmd syntax when told the target is win32. Measured
 *  (dokar/qwen3.5-9B, 2026-08-09): that teaching does not hold — 19 of 25 Bash calls failed, the model
 *  mixing PowerShell (`Select-String`), bash and cmd dialects inside single commands, and multi-line
 *  commands ran only their FIRST line (cmd stops at the newline) while exiting 0, so its "cleanup"
 *  deletes silently never happened. A tool NAMED Bash that speaks cmd is a contradiction a weak model
 *  cannot hold. Git Bash ships with Git for Windows — near-universal on a dev machine — and gives the
 *  model the one dialect its training prior expects; cmd.exe stays the fallback. */
const isWindows = process.platform === 'win32'

/** A real bash for host-mode commands. Probes CASCADE_BASH (explicit override), then Git for Windows'
 *  install locations. Deliberately NEVER bare `bash` from PATH: on Windows that can resolve to
 *  System32's WSL launcher, whose filesystem view (/mnt/c/…) breaks every path the file tools use. */
function findHostBash(): string | undefined {
	if (!isWindows) return undefined
	const candidates = [
		process.env.CASCADE_BASH,
		process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
		process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
	]
	for (const c of candidates) if (c && existsSync(c)) return c
	return undefined
}
const hostBash = findHostBash()
/** Exported for tests: which shell host-mode Bash actually gets on THIS machine. */
export const hostBashPath = hostBash

export class HostSandbox implements ProjectRuntime {
	readonly kind = 'host' as const
	/** The project IS the root here — no mount to translate. */
	readonly root: string
	/** Commands run through the host shell, so the loop must advertise the syntax of the shell run() will
	 *  actually spawn: Git Bash when found (posix), cmd.exe otherwise (win32). */
	readonly shell = isWindows && !hostBash ? ('win32' as const) : ('posix' as const)

	private dev?: { pid: number; port: number }
	private reservedPort?: number

	constructor(private readonly projectDir: string) {
		this.root = projectDir
	}

	/** ADR-070 step 4: the selected local backend's honest claims (Seatbelt/bwrap ⇒ 'full' + its denial
	 *  dialect; 'none' — Windows today — ⇒ no claim), surfaced through the core seam so Bash's denial
	 *  classifier speaks this host's dialect. Getters because selection is probed lazily, once. */
	get enforcement(): 'full' | 'partial' | undefined {
		return localBackendClaims().enforcement
	}
	get denialSignatures(): readonly string[] | undefined {
		return localBackendClaims().denialSignatures
	}

	async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
		// The SAME refusal Docker mode has had all along, and host mode was missing — which is exactly how a
		// desktop trace ended with the model starting its own dev server via `start /b` and hanging the turn:
		// the Preview owns the dev server in BOTH runtimes, and a second one binds a port nothing is watching.
		const refusal = devServerRefusal(command)
		if (refusal) return { output: refusal, exitCode: 1 }
		// ADR-070 step 4/6: wrap the MODEL's command in the platform's confinement (Seatbelt/bwrap, or the
		// Windows write-fence) per the call's policy. Passthrough when no policy / danger-full-access / no
		// usable backend — so an unconfigured host path is byte-identical, and product-owned commands
		// (installDependencies, startDev, stopDev's taskkill) which call run() directly are deliberately
		// NOT confined: they are ours, not the model's.
		const confined = confineHostCommand(command, opts.policy)
		// The fence uses argv form: spawn its runner from runnerCwd (where `tsx` resolves), NOT the project
		// workspace — the runner sets the CHILD's cwd to the workspace itself via its --workspace flag.
		if (confined.argv) return run(confined.command, confined.runnerCwd ?? this.projectDir, opts, confined.argv)
		return run(confined.command, opts.cwd ?? this.projectDir, opts)
	}

	/**
	 * Are the project's DECLARED dependencies actually installed?
	 *
	 * "node_modules is non-empty" is not the same question, and the difference is a real failure: the agent
	 * fixing a missing import with `npm install lucide-react` creates a node_modules containing that package
	 * and nothing else. A non-empty check then reports "installed", the preview skips its install, and Vite
	 * dies on the first template dependency it cannot resolve — measured exactly that way, with 34 entries
	 * present and `@tailwindcss/vite` missing, surfacing only as "Couldn't start the preview".
	 *
	 * Checks every declared dependency rather than sampling: a partial install is precisely the case that
	 * matters, and the check is a handful of stats against a directory the OS has cached.
	 */
	async hasDependencies(): Promise<boolean> {
		let declared: string[]
		try {
			const pkg = JSON.parse(readFileSync(join(this.projectDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
			declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
		} catch {
			// No package.json to compare against — fall back to the weaker question rather than claiming
			// dependencies are missing for a project that may not use npm at all.
			try {
				return readdirSync(join(this.projectDir, 'node_modules')).length > 0
			} catch {
				return false
			}
		}
		if (!declared.length) return true // nothing to install is the same as installed
		const modules = join(this.projectDir, 'node_modules')
		return declared.every((name) => existsSync(join(modules, ...name.split('/'))))
	}

	async installDependencies(onData?: (chunk: string) => void): Promise<boolean> {
		// ADR-070 step 3: declare + provision the project's toolchains FIRST, so the npm that installs is
		// the project's pinned one (from the Cascade prefix), not whatever the host happens to have. Both
		// are best-effort no-ops without mise — the host path must keep working on a bare machine.
		ensureProjectToolchainConfig(this.projectDir)
		await installProjectToolchains(this.projectDir, onData)
		const res = await run('npm install --no-audit --no-fund', this.projectDir, { onData })
		return res.exitCode === 0
	}

	/**
	 * A free port, reserved once and remembered.
	 *
	 * Docker publishes `-p 0:5173` and asks the daemon what it bound, which is race-free. On the host we do
	 * the same trick with the OS: bind port 0, read the assignment, release it. There is a window between
	 * release and Vite binding, but it is the same window every dev tool lives with, and the alternative —
	 * a fixed 5173 — collides the moment a second project runs, which is the normal case here.
	 */
	async previewPort(): Promise<number> {
		if (this.reservedPort) return this.reservedPort
		this.reservedPort = await freePort()
		return this.reservedPort
	}

	async startDev(env: Record<string, string>): Promise<void> {
		await this.stopDev() // never leave a previous dev server holding the port we are about to ask for
		const port = await this.previewPort()
		mkdirSync(join(this.projectDir, '.cascade'), { recursive: true })
		// Truncate: the log is per-start, and a follower showing the PREVIOUS run's errors is worse than none.
		const out = openSync(devLogPath(this.projectDir), 'w')

		// `--` forwards to Vite, overriding the template's fixed 5173. Without this every project would race
		// for one port and the loser would silently drift to 5174 — the exact failure Docker mode hits.
		const child = spawn(npm(), ['run', 'dev', '--', '--host', '--port', String(port)], {
			cwd: this.projectDir,
			// ADR-070: mise shims first, so the dev server runs on the project's pinned toolchain too.
			env: { ...process.env, ...miseEnv(), ...env },
			stdio: ['ignore', out, out],
			detached: !isWindows, // POSIX: its own process group, so we can kill the whole tree
			shell: isWindows, // Windows needs a shell to resolve npm.cmd
			windowsHide: true,
		})
		child.unref()
		if (child.pid) {
			this.dev = { pid: child.pid, port }
			try {
				writeFileSync(devPidPath(this.projectDir), JSON.stringify({ pid: child.pid, port }))
			} catch {
				/* an unwritable project loses reclaim-after-restart, not the dev server */
			}
		}
	}

	async stopDev(): Promise<void> {
		// Fall back to the RECORDED pid when this instance never started one — the usual case after a server
		// restart, where the process is still running and still holding its port.
		const dev = this.dev ?? readDevRecord(this.projectDir)
		this.dev = undefined
		try {
			rmSync(devPidPath(this.projectDir), { force: true })
		} catch {
			/* nothing to clean up */
		}
		if (!dev) return

		// Guard against PID REUSE. A recorded pid from a previous boot may since have been handed to an
		// unrelated process, and killing a stranger's process because we once used that number would be a
		// genuinely hostile bug. If nothing is listening on the port we recorded, the dev server is already
		// gone and there is nothing to do.
		if (!(await isListening(dev.port))) return

		// By PID, not by name. `pkill -f vite` (what the container does) cannot tell OUR dev server from one
		// the user started in their own terminal — safe inside a container that holds nothing else, unsafe here.
		try {
			if (isWindows) {
				// A detached npm spawns a child vite; /T takes the tree, which is what actually frees the port.
				await run(`taskkill /PID ${dev.pid} /T /F`, this.projectDir, {})
			} else {
				// Negative pid = the group created by detached:true. Fall back to the bare pid if the process
				// was not group-leader (it always is here, but a failed setsid must not leave it running).
				try {
					process.kill(-dev.pid, 'SIGTERM')
				} catch {
					process.kill(dev.pid, 'SIGTERM')
				}
			}
		} catch {
			/* already gone — the desired state either way */
		}
	}

	async devLog(lines: number): Promise<string> {
		try {
			const text = await readFile(devLogPath(this.projectDir), 'utf8')
			return text.split('\n').slice(-lines).join('\n')
		} catch {
			return ''
		}
	}

	followDevLog(onLine: (line: string) => void, signal: AbortSignal): void {
		const file = devLogPath(this.projectDir)
		let offset = 0
		let buf = ''
		let closed = false

		const emit = (chunk: string) => {
			buf += chunk
			const parts = buf.split('\n')
			buf = parts.pop() ?? '' // hold the partial last line until its newline arrives
			for (const l of parts) onLine(stripAnsi(l))
		}

		// Read from `offset` to EOF, then remember where we stopped. This is `tail -f` without a shell.
		const pump = () => {
			if (closed) return
			let size = 0
			try {
				size = statSync(file).size
			} catch {
				return // not created yet; the watcher below will call us again
			}
			if (size < offset) offset = 0 // truncated by a restart — follow the new file from its start
			if (size === offset) return
			const stream = createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' })
			offset = size
			stream.on('data', (c) => emit(String(c)))
			stream.on('error', () => {})
		}

		mkdirSync(join(this.projectDir, '.cascade'), { recursive: true })
		pump() // backlog first, so the pane is not empty until the next write
		// Watch the DIRECTORY, not the file: the log may not exist yet, and a restart replaces it.
		let watcher: ReturnType<typeof watch> | undefined
		try {
			watcher = watch(join(this.projectDir, '.cascade'), () => pump())
		} catch {
			/* fall through to polling */
		}
		// Poll as well. fs.watch misses writes on some filesystems and network drives, and a Console pane
		// that silently stops updating is indistinguishable from a dev server that stopped logging.
		const timer = setInterval(pump, 1000)
		timer.unref?.()

		signal.addEventListener('abort', () => {
			closed = true
			clearInterval(timer)
			watcher?.close()
		})
	}

	async dispose(): Promise<void> {
		await this.stopDev()
	}
}

/**
 * Sweep dev servers orphaned by PREVIOUS runs, across every project under `root` — host mode's answer to
 * `sweepSandboxContainers`. Measured (2026-08-10): 55 stale project dev servers had accumulated across
 * sessions, each holding a port and memory, because per-project reclaim only runs when THAT project is
 * reopened — projects never reopened leak forever. Reuses stopDev per recorded project: it already guards
 * pid reuse (kills only when the recorded port is actually listening) and removes the record either way.
 * Returns the number of records handled.
 */
export async function sweepHostDevServers(root: string): Promise<number> {
	let dirs: string[]
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(root, e.name))
	} catch {
		return 0 // no projects root yet — nothing to sweep
	}
	let swept = 0
	for (const dir of dirs) {
		if (!existsSync(devPidPath(dir))) continue
		swept++
		await new HostSandbox(dir).stopDev().catch(() => {})
	}
	return swept
}

/** npm is a .cmd shim on Windows and only resolves through a shell — hence `shell: true` at the call site. */
const npm = () => (isWindows ? 'npm.cmd' : 'npm')

/** The dev server recorded by a PREVIOUS run of this process, if any. Tolerant: a missing or corrupt file
 *  simply means "nothing to reclaim". */
function readDevRecord(dir: string): { pid: number; port: number } | undefined {
	try {
		const r = JSON.parse(readFileSync(devPidPath(dir), 'utf8')) as { pid?: number; port?: number }
		return r?.pid && r?.port ? { pid: r.pid, port: r.port } : undefined
	} catch {
		return undefined
	}
}

/** Is anything accepting connections on this port? Used to confirm a recorded pid is still OUR dev server
 *  before killing it — see stopDev's note on pid reuse. */
function isListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ port, host: '127.0.0.1' })
		const done = (answer: boolean) => {
			sock.destroy()
			resolve(answer)
		}
		sock.setTimeout(500)
		sock.once('connect', () => done(true))
		sock.once('timeout', () => done(false))
		sock.once('error', () => done(false))
	})
}

/** Ask the OS for an unused port by binding 0 and reading what it gave us. Exported for WslSandbox,
 *  whose preview port is a HOST port too (WSL2 localhostForwarding serves it on the same number). */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address()
			const port = typeof addr === 'object' && addr ? addr.port : 0
			srv.close(() => (port ? resolve(port) : reject(new Error('could not reserve a port'))))
		})
	})
}

/**
 * Run one command through the host shell, streaming combined output.
 *
 * Settles on 'exit', NOT 'close' — the distinction core's Bash already learned the hard way (measured
 * 2026-07-30: a dev server started with `start /b` left a grandchild holding the inherited stdout pipe, so
 * 'close' never fired and the call hung 37+ minutes on a 120s deadline). This function reintroduced that
 * hang for host mode, where Bash routes through the sandbox and core's own fix is bypassed — confirmed in
 * a desktop trace as an AGENT turn stuck on an open `tool Bash` span running `start /b cmd /c …`.
 *
 * On abort, the tree is killed on Windows: the `signal` option kills only the direct cmd.exe wrapper, and
 * the grandchild it spawned survives holding its port — the same reason stopDev kills with /T.
 */
function run(command: string, cwd: string, opts: { signal?: AbortSignal; onData?: (s: string) => void }, argv?: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		if (!existsSync(cwd)) return resolve({ output: `cwd does not exist: ${cwd}`, exitCode: 1 })
		// ADR-070 step 6: an ARGV-form backend (the write-fence) spawns its runner directly with NO shell,
		// so the model's command — the runner's final argv element — is never re-parsed by a shell.
		// Otherwise: Git Bash when available (node spawns a non-cmd shell string as `bash.exe -c <command>`),
		// cmd otherwise. ADR-070 step 3: mise shims prepended (empty spread when mise is absent —
		// byte-identical env), so every agent command resolves node/python/etc. through the pinned toolchain.
		const env = { ...process.env, ...miseEnv() }
		const child = argv
			? spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, signal: opts.signal, env })
			: spawn(command, { cwd, shell: hostBash ?? true, windowsHide: true, signal: opts.signal, env })
		let output = ''
		let settled = false
		const finish = (r: ExecResult) => {
			if (settled) return
			settled = true
			resolve(r)
		}
		const take = (c: Buffer) => {
			const s = String(c)
			output += s
			opts.onData?.(s)
		}
		child.stdout?.on('data', take)
		child.stderr?.on('data', take)
		if (isWindows && opts.signal) {
			opts.signal.addEventListener('abort', () => {
				if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
			}, { once: true })
		}
		// An abort or a missing shell errors rather than exiting — both are results, not crashes.
		child.on('error', (e) => finish({ output: output || String(e), exitCode: null }))
		child.on('exit', (code) => {
			// The PROCESS ended; stdio may still be held open by a detached grandchild that is meant to
			// outlive us. Give buffered output one tick to drain, then settle regardless of pipe state.
			setTimeout(() => finish({ output, exitCode: code }), 50)
		})
	})
}
