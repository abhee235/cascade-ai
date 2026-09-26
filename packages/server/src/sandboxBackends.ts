// sandboxBackends.ts — per-OS local confinement backends (ADR-070 Part C, step 4).
//
// The host runtime (ADR-081 §4) runs model-authored commands as real child processes. This module is
// what stops that from meaning "with the user's full authority": on platforms whose kernel offers an
// unprivileged sandbox primitive, every confined command is WRAPPED in that primitive's invocation —
// Seatbelt (`sandbox-exec`, built into macOS) or bubblewrap (`bwrap`, Linux user namespaces) — with a
// profile derived from the SAME `writableRoots()` the file tools use, so shell and file enforcement
// can never disagree about what `workspace-write` means.
//
// Selection is BY PLATFORM CHAIN, arbitrated by bounded functional probes, cached for the process:
//   darwin → seatbelt → none · linux → bwrap → none · win32 → none (the WSL rung is step 5, the
//   write-fence rung step 6). `none` is a VISIBLE downgrade, never a silent one: it claims no
//   enforcement, and the caller (HostSandbox) simply runs the command as before — Windows today.
// The Landlock rung (a second Linux candidate for hosts with user namespaces disabled) needs a bundled
// launcher binary and is deferred; the chain shape already accommodates it.
//
// A probe failure can only ever DOWNGRADE to `none` (fail-open toward usability, loud in the UI); a
// backend that probed fine but refuses at runtime surfaces through the command's own stderr, which the
// tool layer classifies via denialSignatures (ADR-070 step 2).

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxEnforcement, SandboxPolicy } from '@cascade/core'
import { canonicalPath, isConfined, writableRoots } from '@cascade/core'
// Import-safe on every platform: winFence loads advapi32 LAZILY (only when a fence function first runs,
// which is win32-only), and koffi's own native module loads cross-platform. Only the ACL GRANT is ever
// called in-process here; token creation and the restricted spawn live in the runner subprocess.
import { grantWriteAce } from './winFence.js'
import { workspaceWriteSid } from './winFenceSid.js'

export type LocalBackendId = 'seatbelt' | 'bwrap' | 'win-write-fence' | 'none'

export interface ConfinedCommand {
	/** The command to actually spawn — wrapped in the backend's invocation, or the original untouched.
	 *  For an `argv`-form backend this is a human-readable rendering for logs only. */
	command: string
	/** Which backend wrapped it ('none' ⇒ untouched). */
	backend: LocalBackendId
	/** ARGV form: when present the caller MUST spawn argv[0] with argv.slice(1) and NO shell, so the
	 *  model's command (the last element) is never re-parsed. The write-fence uses this — its runner takes
	 *  the command as one argv element after `--`. Shell-string backends (bwrap/seatbelt) omit it. */
	argv?: string[]
	/** ARGV form only: the working dir for the RUNNER PROCESS (distinct from the child's workspace cwd,
	 *  which the runner sets itself). The dev runner is `node --import tsx …`, and node resolves the bare
	 *  `tsx` specifier from THIS dir — so it must be inside the server package, not the (dependency-free)
	 *  project workspace. */
	runnerCwd?: string
	/** The backend's honest enforcement claim; undefined for 'none' (no claim is the honest claim). */
	enforcement?: SandboxEnforcement
	/** The backend's denial dialect (ADR-070 step 2) — consumed by Bash's classifier via the Sandbox seam. */
	denialSignatures?: readonly string[]
	/** ARGV backends only: stderr substrings that mean the RUNNER itself failed (the child never ran), so
	 *  a runner refusal is never misclassified as a policy denial. */
	runnerFailureSignatures?: readonly string[]
	/** ARGV backends only: extra environment the RUNNER PROCESS needs. The fence runner is spawned from
	 *  `process.execPath`, which inside a packaged desktop app is ELECTRON, not node — `ELECTRON_RUN_AS_NODE=1`
	 *  makes it behave as node; without it a confined command would open a second app window (ADR-070 Part D). */
	env?: Record<string, string>
}

/** The bwrap executable: a bundled static binary when the shell points at one (packaged Linux builds —
 *  `CASCADE_BWRAP_PATH`), else the distro's own from PATH (dev, or hosts that ship bubblewrap). */
function bwrapBin(): string {
	const bundled = process.env.CASCADE_BWRAP_PATH
	return bundled && existsSync(bundled) ? bundled : 'bwrap'
}

/** POSIX single-quote escaping: the one quoting form with no inner interpretation. `'` becomes `'\''`. */
export function shq(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`
}

// ── Profile generation (pure — the unit-testable heart) ─────────────────────────────────────────────

/**
 * bwrap arguments for one policy. The whole filesystem is mounted READ-ONLY, then each writable root
 * is re-bound writable on top — `read-only` simply re-binds nothing. /dev and /proc are fresh (tools
 * expect them); --unshare-pid keeps a confined fork-bomb visible; --die-with-parent ties the sandbox
 * to us. Network stays OPEN (ADR-070 working default #2: outbound-open v1).
 */
export function bwrapArgs(policy: SandboxPolicy): string[] {
	const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent']
	if (policy.mode === 'workspace-write') {
		for (const root of writableRoots(policy)) args.push('--bind', root, root)
	}
	return args
}

/**
 * The Seatbelt profile for one policy. `(allow default)` then `(deny file-write*)` is the usual
 * write-jail shape: everything works EXCEPT writes, which are re-allowed per writable root by
 * subpath. Literal paths are embedded in the profile string — escape the two characters Seatbelt's
 * string syntax reserves.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
	const esc = (p: string) => p.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
	const allows =
		policy.mode === 'workspace-write'
			? writableRoots(policy)
					.map((r) => `(allow file-write* (subpath "${esc(r)}"))`)
					.join('\n')
			: ''
	return `(version 1)\n(allow default)\n(deny file-write*)\n${allows}`.trimEnd()
}

/** Wrap one shell command in the selected backend's invocation for one policy. Pure given a backend id. */
export function wrapCommand(backend: LocalBackendId, command: string, policy: SandboxPolicy): string {
	switch (backend) {
		case 'bwrap':
			return `${shq(bwrapBin())} ${bwrapArgs(policy).join(' ')} -- /bin/sh -c ${shq(command)}`
		case 'seatbelt':
			return `sandbox-exec -p ${shq(seatbeltProfile(policy))} /bin/sh -c ${shq(command)}`
		case 'win-write-fence':
			// The fence is argv-form (confineWithFence), never a shell string — this path is unreachable.
			throw new Error('win-write-fence uses argv confinement, not wrapCommand')
		case 'none':
			return command
	}
}

// ── Probes + selection (cached; injectable for tests) ───────────────────────────────────────────────

/** Denial dialect per backend — what a kernel-refused file effect looks like on stderr. */
const DENIAL_SIGNATURES: Record<Exclude<LocalBackendId, 'none'>, readonly string[]> = {
	bwrap: ['read-only file system', 'permission denied'],
	seatbelt: ['operation not permitted'],
	// cmd: "Access is denied."; pwsh/.NET: "Access to the path '…' is denied."; node EACCES: "permission denied".
	'win-write-fence': ['access is denied', 'access to the path', 'permission denied'],
}

/** The write-fence runner's failure signature (the child never ran) — kept in sync with winFenceRunner. */
const FENCE_RUNNER_FAILURE = ['cascade-fence:'] as const

/** Test hooks: replace the platform or a probe (exercise any platform's chain from any host). */
export interface BackendInternals {
	platform?: string
	probeBwrap?: () => boolean
	probeSeatbelt?: () => boolean
	probeWinFence?: () => boolean
}

const PROBE_TIMEOUT_MS = 5_000

/** Functional bwrap probe: can it actually create the read-only profile and run `true` under it? */
function defaultProbeBwrap(): boolean {
	const probe = spawnSync(bwrapBin(), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
		timeout: PROBE_TIMEOUT_MS,
		stdio: 'ignore',
	})
	return probe.status === 0
}

/** Functional Seatbelt probe: apply a real deny-write profile and run `true` under it — exit 0 means
 *  the kernel accepted AND enforced it (`sandbox-exec` exits non-zero when sandbox_init refuses). */
function defaultProbeSeatbelt(): boolean {
	const profile = seatbeltProfile({ mode: 'read-only', workspaceRoot: '/' })
	const probe = spawnSync('sandbox-exec', ['-p', profile, 'true'], { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
	return probe.status === 0
}

const PLATFORM_CHAINS: Record<string, readonly Exclude<LocalBackendId, 'none'>[]> = {
	darwin: ['seatbelt'],
	linux: ['bwrap'], // landlock joins here when its launcher is bundled (deferred — see header)
	win32: ['win-write-fence'], // the WSL runtime is the primary Windows isolation; this fence is the host-mode fallback
}

/**
 * Functional write-fence probe: run the RUNNER itself, read-only, around `cmd /c exit 0`, with a bounded
 * timeout — exit 0 proves the whole production path works on this machine (runner host, koffi resolution,
 * token creation, and the console semantics a restricted child needs).
 *
 * Deliberately NOT in-process FFI. The server runs inside Electron's main thread in the packaged app; a
 * synchronous CreateProcessAsUser + WaitForSingleObject there can block the entire UI if the child never
 * initializes (a restricted child with no inheritable console dies or wedges in DLL init — measured as an
 * app that launched but never served). A subprocess with a timeout can degrade to 'none'; it can never hang
 * the app. It also means token/spawn FFI only ever executes in the runner process, never in the server.
 */
function defaultProbeWinFence(): boolean {
	try {
		const argv = [...fenceRunnerArgv(), '--workspace', process.cwd(), '--mode', 'read-only', '--', 'exit 0']
		const probe = spawnSync(argv[0], argv.slice(1), {
			cwd: fileURLToPath(new URL('.', import.meta.url)), // where `tsx` resolves in dev; harmless when bundled
			env: { ...process.env, ...fenceRunnerEnv() },
			timeout: 20_000,
			stdio: 'ignore',
			windowsHide: true,
		})
		return probe.status === 0
	} catch {
		return false
	}
}

/** Grants applied this process lifetime, keyed by canonical workspace path — the standing-ACE reuse cache
 *  (a workspace's write ACE is an expensive full-tree propagation; do it once, never per exec). */
const grantedWorkspaces = new Set<string>()

/**
 * The node that HOSTS the fence runner. The bundled portable node (`CASCADE_NODE_DIR/node.exe`, ADR-070
 * Part D) when shipped, else this process's own executable.
 *
 * Load-bearing, not cosmetic: a child created under the restricted token cannot CREATE a console — it
 * dies during DLL init with STATUS_DLL_INIT_FAILED (0xC0000142) — it can only INHERIT one. `node.exe` is a
 * console-subsystem binary, so spawned with `windowsHide` it owns an invisible console the confined
 * `cmd.exe` shares. Electron is a GUI-subsystem binary: even as `ELECTRON_RUN_AS_NODE` it has no console,
 * and every confined command dies with exactly that code (measured on the first packaged build). So the
 * packaged app must never host the runner in itself — the bundled node is the fix, and it is already shipped.
 */
function fenceHostNode(): string {
	const dir = process.env.CASCADE_NODE_DIR
	const bundled = dir ? join(dir, process.platform === 'win32' ? 'node.exe' : 'node') : undefined
	return bundled && existsSync(bundled) ? bundled : process.execPath
}

/** The runner invocation prefix, in order: the BUNDLED runner the desktop shell points at
 *  (`CASCADE_FENCE_RUNNER`, ADR-070 Part D), a built sibling entry, else the .ts source via tsx (dev). A
 *  future native-exe runner keeps the same argv contract and only swaps these entries. */
export function fenceRunnerArgv(): string[] {
	const host = fenceHostNode()
	const bundled = process.env.CASCADE_FENCE_RUNNER
	if (bundled && existsSync(bundled)) return [host, bundled]
	const builtEntry = fileURLToPath(new URL('./winFenceRunner.js', import.meta.url))
	if (existsSync(builtEntry)) return [host, builtEntry]
	const srcEntry = fileURLToPath(new URL('./winFenceRunner.ts', import.meta.url))
	return [host, '--import', 'tsx', srcEntry]
}

/** Env the runner process needs beyond the caller's. Only when the host is this process AND this process
 *  is Electron: `ELECTRON_RUN_AS_NODE=1` makes the app binary run a script as node (the dev-in-Electron
 *  case; the packaged app hosts the runner in the bundled node instead — see fenceHostNode). */
export function fenceRunnerEnv(): Record<string, string> {
	return process.versions.electron && fenceHostNode() === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

let cachedBackend: LocalBackendId | undefined

/** Test hook + config-change hook: forget the cached selection. */
export function resetBackendCache(): void {
	cachedBackend = undefined
}

/** Resolve which backend confines host commands, once per process: this platform's chain, each rung
 *  functionally probed in order; no chain or no passing rung ⇒ 'none'. Kill-switch: CASCADE_SANDBOX=off
 *  (the ADR-024 opt-out, honored here for the same reason). */
export function selectLocalBackend(internals: BackendInternals = {}): LocalBackendId {
	if (internals.platform === undefined && cachedBackend !== undefined) return cachedBackend
	const select = (): LocalBackendId => {
		if (process.env.CASCADE_SANDBOX === 'off') return 'none'
		const chain = PLATFORM_CHAINS[internals.platform ?? process.platform] ?? []
		for (const rung of chain) {
			const probe =
				rung === 'bwrap'
					? (internals.probeBwrap ?? defaultProbeBwrap)
					: rung === 'seatbelt'
						? (internals.probeSeatbelt ?? defaultProbeSeatbelt)
						: (internals.probeWinFence ?? defaultProbeWinFence)
			if (probe()) return rung
		}
		return 'none'
	}
	const picked = select()
	if (internals.platform === undefined) cachedBackend = picked // cache only real-platform verdicts
	return picked
}

/** The write-fence enforces WRITES only (reads/network/exec stay open) plus the documented Everyone and
 *  hard-link boundaries — so it is honestly `partial`. bwrap/Seatbelt govern every promised effect by
 *  construction, so they are `full`. */
function enforcementOf(backend: Exclude<LocalBackendId, 'none'>): SandboxEnforcement {
	return backend === 'win-write-fence' ? 'partial' : 'full'
}

/** The selected backend's standing claims, for the core Sandbox seam's readonly fields (HostSandbox
 *  surfaces these so Bash's denial classifier knows this host's dialect). No backend ⇒ no claims. */
export function localBackendClaims(): { enforcement?: SandboxEnforcement; denialSignatures?: readonly string[] } {
	const backend = selectLocalBackend()
	if (backend === 'none') return {}
	return { enforcement: enforcementOf(backend), denialSignatures: DENIAL_SIGNATURES[backend] }
}

/** Ensure the workspace's write ACE exists, once per canonical path per process (the standing reuse cache). */
function ensureWorkspaceGrant(workspaceRoot: string, sid: string): void {
	const key = canonicalPath(workspaceRoot)
	if (grantedWorkspaces.has(key)) return
	grantWriteAce(key, sid)
	grantedWorkspaces.add(key)
}

/** Build the write-fence's argv-form confinement: the runner prefix + policy flags + `--` + the model's
 *  command as ONE element (never reshelled). Under workspace-write it grants the workspace once and points
 *  the child's TMP/TEMP at a workspace-private temp dir the runner creates. */
function confineWithFence(command: string, policy: SandboxPolicy): ConfinedCommand {
	const runner = fenceRunnerArgv()
	const flags = ['--workspace', policy.workspaceRoot, '--mode', policy.mode]
	if (policy.mode === 'workspace-write') {
		const sid = workspaceWriteSid(policy.workspaceRoot)
		ensureWorkspaceGrant(policy.workspaceRoot, sid)
		flags.push('--write-sid', sid, '--temp-dir', join(policy.workspaceRoot, '.cascade', 'tmp'))
	}
	const argv = [...runner, ...flags, '--', command]
	return {
		command: `[win-write-fence:${policy.mode}] ${command}`,
		backend: 'win-write-fence',
		argv,
		runnerCwd: fileURLToPath(new URL('.', import.meta.url)), // this src dir — where `tsx` resolves
		env: fenceRunnerEnv(),
		enforcement: 'partial',
		denialSignatures: DENIAL_SIGNATURES['win-write-fence'],
		runnerFailureSignatures: FENCE_RUNNER_FAILURE,
	}
}

/**
 * Confine one host command under one policy — the single entry point HostSandbox uses. Passthrough
 * when: no policy (the pre-ADR-070 caller), an unconfined mode (`danger-full-access`), or no usable
 * backend ('none'). Otherwise the wrapped invocation plus the backend's claims, which HostSandbox
 * surfaces through the core Sandbox seam so the tool layer's denial classifier engages.
 */
export function confineHostCommand(command: string, policy: SandboxPolicy | undefined, internals: BackendInternals = {}): ConfinedCommand {
	if (!policy || !isConfined(policy.mode)) return { command, backend: 'none' }
	const backend = selectLocalBackend(internals)
	if (backend === 'none') return { command, backend }
	if (backend === 'win-write-fence') return confineWithFence(command, policy)
	return {
		command: wrapCommand(backend, command, policy),
		backend,
		enforcement: 'full',
		denialSignatures: DENIAL_SIGNATURES[backend],
	}
}
