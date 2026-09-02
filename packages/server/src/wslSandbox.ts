// wslSandbox.ts — the Windows WSL2 runtime (ADR-070 Part C, step 5): hermetic, productized.
//
// The primary Windows isolation rung. One imported utility distro (`cascade-sandbox`, a WSL2 VM —
// the same Hyper-V boundary the hermetic project validated by hand) runs EVERY project's commands;
// Windows keeps owning the project files. The bridge is a per-project drvfs mount: the project dir —
// and ONLY the project dir — is mounted at /projects/<key> inside the distro, which makes the
// workspace-write policy PHYSICAL: with automount and interop disabled in /etc/wsl.conf (measured:
// a freshly imported distro auto-mounts the entire C: drive at /mnt/c and can launch Windows
// executables — out of the box it isolates NOTHING), the rest of the host filesystem simply does not
// exist inside the VM. node_modules is shadowed by a distro-native directory (bind mount) for the
// same reason DockerSandbox uses a named volume: npm over a Windows↔Linux 9p mount is pathologically
// slow; source files stay on the mount so the host file tools and git see every edit.
//
// In-VM policy (read-only vs workspace-write) rides bwrap INSIDE the distro when the rootfs carries
// it — the same wrapper shape as the Linux host backend, VM + namespace, defense in depth. Without
// bwrap the VM boundary still protects the HOST fully; read-only mode then rests on core's in-process
// Bash fence (step 2).
//
// Distro lifecycle: `ensureDistro()` imports the bundled rootfs (CASCADE_WSL_ROOTFS, produced by
// scripts/build-wsl-rootfs.ps1) on first use — silent, seconds, no admin — writes wsl.conf, restarts
// the distro, and VERIFIES the boundary with a real probe (`test -e /mnt/c/Windows` must fail; a bare
// `ls /mnt/c` lies — an empty mount-point dir exits 0). Fail-closed: an unverified distro is not used.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ExecOptions, ExecResult, SandboxPolicy } from '@cascade/core'
import { isConfined } from '@cascade/core'
import { devServerRefusal } from './dockerSandbox.js'
import { HostSandbox, freePort } from './hostSandbox.js'
import { type ProjectRuntime, stripAnsi } from './projectRuntime.js'
import { shq } from './sandboxBackends.js'

export const WSL_DISTRO = 'cascade-sandbox'

/** Force UTF-8 from wsl.exe's own messages (they are UTF-16LE by default — unparseable garbage to a
 *  byte-wise reader). The confined command's OWN output is untouched either way. */
const wslEnv = () => ({ ...process.env, WSL_UTF8: '1' })

/** One bounded wsl.exe management call (list, import, terminate). `--exec` is NOT used here — these
 *  are wsl.exe's own verbs, not in-distro commands. */
function wslSync(args: string[], timeoutMs = 60_000): { status: number | null; output: string } {
	const r = spawnSync('wsl.exe', args, { env: wslEnv(), timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
	return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Run one shell script inside the distro, synchronously, bounded. `--exec` (not `--`) on purpose:
 *  `--` re-parses the remainder through the distro's default shell — a double-parse that mangles
 *  quoting — while `--exec` passes argv straight to /bin/sh. */
function wslShellSync(script: string, timeoutMs = 60_000): { status: number | null; output: string } {
	return wslSync(['-d', WSL_DISTRO, '--exec', '/bin/sh', '-c', script], timeoutMs)
}

// ── Pure builders (the unit-testable heart) ─────────────────────────────────────────────────────────

/** A filesystem-safe per-project key, same derivation as DockerSandbox's node_modules volume name. */
export function projectKey(projectDir: string): string {
	return (basename(projectDir.replace(/[\\/]+$/, '')) || 'project').replace(/[^a-zA-Z0-9_.-]/g, '-')
}

/** The in-distro project root — the `Sandbox.root` alias the model sees and the file tools reconcile. */
export const linuxRoot = (key: string) => `/projects/${key}`

/**
 * The idempotent mount prelude prefixed to EVERY in-distro command. Needed every time because the
 * distro VM auto-terminates seconds after its last process exits, dropping all mounts: (1) drvfs-mount
 * the project dir (the ONLY host path the VM can reach — automount is off), (2) shadow node_modules
 * with a distro-native dir (9p-speed npm is the measured Docker lesson, same fix). `mountpoint -q`
 * makes re-runs free while the VM is warm (a dev server keeps it alive).
 */
export function mountPrelude(projectDir: string, key: string): string {
	const root = linuxRoot(key)
	const nm = `/var/cascade/nm/${key}`
	return [
		`mkdir -p ${shq(root)} ${shq(nm)}`,
		`mountpoint -q ${shq(root)} || mount -t drvfs ${shq(projectDir)} ${shq(root)}`,
		`mkdir -p ${shq(`${root}/node_modules`)}`,
		`mountpoint -q ${shq(`${root}/node_modules`)} || mount --bind ${shq(nm)} ${shq(`${root}/node_modules`)}`,
	].join(' && ')
}

/** bwrap arguments for the IN-DISTRO wrap. Not core's writableRoots(): that derivation canonicalizes
 *  on the CALLING platform, and Windows-canonical paths (the host tmpdir) don't exist inside the VM —
 *  bwrap refuses a missing bind source. The linux-side meaning of each mode is spelled here directly. */
export function bwrapArgsInDistro(policy: SandboxPolicy, key: string): string[] {
	const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent']
	if (policy.mode === 'workspace-write') args.push('--bind', linuxRoot(key), linuxRoot(key), '--bind', '/tmp', '/tmp')
	return args
}

/** The complete in-distro script for one exec: mount, cd, then the command — bwrap-wrapped when the
 *  policy confines and the rootfs carries bwrap. */
export function buildExecScript(projectDir: string, key: string, command: string, policy: SandboxPolicy | undefined, bwrapInside: boolean): string {
	const root = linuxRoot(key)
	const confined = policy !== undefined && isConfined(policy.mode) && bwrapInside
	const run = confined ? `bwrap ${bwrapArgsInDistro(policy, key).join(' ')} -- /bin/sh -c ${shq(`cd ${root} && ${command}`)}` : `cd ${shq(root)} && ${command}`
	return `${mountPrelude(projectDir, key)} && ${run}`
}

// ── Distro lifecycle (module-level: ONE distro serves every project) ────────────────────────────────

/** The wsl.conf that makes the boundary real. automount off: no /mnt/c (measured: on by default —
 *  full host filesystem access). interop off: no launching Windows executables from inside, and no
 *  Windows PATH leaking in. Manual drvfs mounts (our per-project bridge) are unaffected. */
export const WSL_CONF = '[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n'

export type DistroStatus = 'ready' | 'unavailable'

let distroStatus: DistroStatus | undefined
let bwrapInsideCached: boolean | undefined

/** Test hook: forget the cached distro/bwrap verdicts. */
export function resetWslCache(): void {
	distroStatus = undefined
	bwrapInsideCached = undefined
}

/** Is WSL itself present on this machine? */
export function wslAvailable(): boolean {
	return process.platform === 'win32' && wslSync(['--status'], 15_000).status === 0
}

/** Is the cascade distro registered? (`-q` prints bare names; WSL_UTF8 keeps them parseable.) */
export function distroRegistered(): boolean {
	const { status, output } = wslSync(['-l', '-q'], 15_000)
	return status === 0 && output.split(/\r?\n/).some((l) => l.trim() === WSL_DISTRO)
}

/** Where the distro's disk lives — under the same Cascade-owned area as the toolchain prefix. */
function distroInstallDir(): string {
	return process.env.CASCADE_WSL_INSTALL_DIR ?? join(process.env.LOCALAPPDATA ?? '.', 'Cascade', 'sandbox')
}

/**
 * Ensure the distro exists, is configured, and its boundary VERIFIED — once per process. Import path:
 * the bundled rootfs named by CASCADE_WSL_ROOTFS (built by scripts/build-wsl-rootfs.ps1). An already
 * registered distro (a previous run's import, or a hand-built one) is re-verified, not re-imported.
 * Fail-closed: any step failing ⇒ 'unavailable' and the runtime is not offered — never a silently
 * unconfigured VM with the whole C: drive mounted.
 */
export function ensureDistro(): DistroStatus {
	if (distroStatus !== undefined) return distroStatus
	distroStatus = (() => {
		if (!wslAvailable()) return 'unavailable'
		if (!distroRegistered()) {
			const rootfs = process.env.CASCADE_WSL_ROOTFS
			if (!rootfs || !existsSync(rootfs)) return 'unavailable'
			const dest = distroInstallDir()
			mkdirSync(dest, { recursive: true })
			if (wslSync(['--import', WSL_DISTRO, dest, rootfs, '--version', '2'], 300_000).status !== 0) return 'unavailable'
		}
		// Configure + restart + VERIFY, even for a pre-existing distro: the conf write is idempotent and
		// the probe is what we actually trust. `printf %s` keeps the conf byte-exact through the shell.
		if (wslShellSync(`printf %s ${shq(WSL_CONF)} > /etc/wsl.conf`).status !== 0) return 'unavailable'
		wslSync(['--terminate', WSL_DISTRO], 30_000) // apply; failure only means it wasn't running
		const probe = wslShellSync('test ! -e /mnt/c/Windows && echo boundary-ok')
		if (probe.status !== 0 || !probe.output.includes('boundary-ok')) return 'unavailable'
		return 'ready'
	})()
	return distroStatus
}

/** Does the rootfs carry bwrap? Probed once; decides whether in-VM policy gets the namespace wrap. */
function bwrapInside(): boolean {
	bwrapInsideCached ??= wslShellSync('command -v bwrap >/dev/null && echo yes').output.includes('yes')
	return bwrapInsideCached
}

/** Can the WSL runtime be offered at all (wsl.exe + a registered distro or a bundled rootfs)? Cheap
 *  pre-check for the runtime selector; ensureDistro() remains the authority. */
export function wslRuntimeUsable(): boolean {
	return ensureDistro() === 'ready'
}

// ── The runtime ─────────────────────────────────────────────────────────────────────────────────────

export class WslSandbox implements ProjectRuntime {
	readonly kind = 'wsl' as const
	/** The VM runs busybox/ash — POSIX whatever the host is (the same declaration Docker makes). */
	readonly shell = 'posix' as const
	readonly root: string
	/** ADR-070: the VM boundary governs host protection by construction; in-VM mode enforcement adds
	 *  bwrap when present. 'full' is the honest claim for the promise the seam makes (the HOST). */
	readonly enforcement = 'full' as const
	readonly denialSignatures = ['read-only file system', 'permission denied'] as const

	private readonly key: string
	/** dev.log lands on the drvfs mount — a REAL host file under <projectDir>\.cascade — so the log
	 *  reader/follower is literally the host implementation, delegated. */
	private readonly logs: HostSandbox
	private reservedPort?: number

	constructor(private readonly projectDir: string) {
		this.key = projectKey(projectDir)
		this.root = linuxRoot(this.key)
		this.logs = new HostSandbox(projectDir)
	}

	/** Run one in-distro script asynchronously, streaming combined output. */
	private run(script: string, opts: { signal?: AbortSignal; onData?: (s: string) => void } = {}): Promise<ExecResult> {
		if (ensureDistro() !== 'ready') {
			return Promise.resolve({ output: 'WSL sandbox unavailable: the cascade-sandbox distro is not ready (missing WSL, rootfs, or boundary verification failed).', exitCode: 1 })
		}
		return new Promise((resolve) => {
			const child = spawn('wsl.exe', ['-d', WSL_DISTRO, '--exec', '/bin/sh', '-c', script], { env: wslEnv(), windowsHide: true, signal: opts.signal })
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
			child.on('error', (e) => finish({ output: output || String(e), exitCode: null }))
			// 'exit', not 'close' — the same detached-grandchild lesson as HostSandbox.run (a dev server's
			// pipes outlive the launcher; waiting for them held a 120s call hostage for 37 minutes).
			child.on('exit', (code) => setTimeout(() => finish({ output, exitCode: code }), 50))
		})
	}

	async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const refusal = devServerRefusal(command)
		if (refusal) return { output: refusal, exitCode: 1 }
		return this.run(buildExecScript(this.projectDir, this.key, command, opts.policy, bwrapInside()), { signal: opts.signal, onData: opts.onData })
	}

	/** POPULATED, not present — node_modules is the distro-native shadow (invisible from Windows), so
	 *  only an in-distro check can answer (the exact Docker named-volume lesson). */
	async hasDependencies(): Promise<boolean> {
		const r = await this.exec('[ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no')
		return r.output.includes('yes')
	}

	async installDependencies(onData?: (chunk: string) => void): Promise<boolean> {
		const r = await this.exec('npm install --no-audit --no-fund', { onData })
		return r.exitCode === 0
	}

	/** A free WINDOWS port: WSL2's localhostForwarding makes a service listening inside the VM on P
	 *  reachable at localhost:P on the host, so one number serves both sides (reserve where the browser
	 *  connects — the host — and tell Vite to bind the same number inside). */
	async previewPort(): Promise<number> {
		this.reservedPort ??= await freePort()
		return this.reservedPort
	}

	async startDev(env: Record<string, string>): Promise<void> {
		await this.stopDev()
		const port = await this.previewPort()
		const envPrefix = Object.entries(env)
			.map(([k, v]) => `${k}=${shq(v)}`)
			.join(' ')
		// setsid → the pid file records a process-GROUP leader, so stopDev kills npm AND the vite it
		// spawned. The log rides the drvfs mount: it IS <projectDir>\.cascade\dev.log on the host, which
		// is what lets devLog/followDevLog delegate to the host implementation.
		const script =
			`${mountPrelude(this.projectDir, this.key)} && cd ${shq(this.root)} && mkdir -p .cascade && ` +
			`setsid env ${envPrefix} npm run dev -- --host --port ${port} > .cascade/dev.log 2>&1 & echo $! > ${shq(this.root)}/.cascade/dev.pid`
		await this.run(script)
	}

	async stopDev(): Promise<void> {
		// Kill by recorded process group, inside the VM. Group-scoped (never pkill-by-name): several
		// projects share this one distro, and a name match cannot tell their dev servers apart.
		const script = `${mountPrelude(this.projectDir, this.key)} && cd ${shq(this.root)} && [ -f .cascade/dev.pid ] && { kill -TERM -"$(cat .cascade/dev.pid)" 2>/dev/null; rm -f .cascade/dev.pid; } || true`
		await this.run(script).catch(() => {})
	}

	async devLog(lines: number): Promise<string> {
		return this.logs.devLog(lines)
	}

	followDevLog(onLine: (line: string) => void, signal: AbortSignal): void {
		// Reuse the host follower (poll-based — fs.watch is exactly what does NOT cross a 9p mount), but
		// strip ANSI the same way it does; the underlying file is the same bytes either way.
		this.logs.followDevLog((l) => onLine(stripAnsi(l)), signal)
	}

	async dispose(): Promise<void> {
		await this.stopDev()
		// The distro itself is SHARED across projects and deliberately outlives any one runtime — it is
		// the reuse cache (same design as the standing toolchain prefix). `wsl --unregister
		// cascade-sandbox` is the user-facing full reset.
	}
}
