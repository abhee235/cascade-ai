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
import type { SandboxEnforcement, SandboxPolicy } from '@cascade/core'
import { isConfined, writableRoots } from '@cascade/core'

export type LocalBackendId = 'seatbelt' | 'bwrap' | 'none'

export interface ConfinedCommand {
	/** The command to actually spawn — wrapped in the backend's invocation, or the original untouched. */
	command: string
	/** Which backend wrapped it ('none' ⇒ untouched). */
	backend: LocalBackendId
	/** The backend's honest enforcement claim; undefined for 'none' (no claim is the honest claim). */
	enforcement?: SandboxEnforcement
	/** The backend's denial dialect (ADR-070 step 2) — consumed by Bash's classifier via the Sandbox seam. */
	denialSignatures?: readonly string[]
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
			return `bwrap ${bwrapArgs(policy).join(' ')} -- /bin/sh -c ${shq(command)}`
		case 'seatbelt':
			return `sandbox-exec -p ${shq(seatbeltProfile(policy))} /bin/sh -c ${shq(command)}`
		case 'none':
			return command
	}
}

// ── Probes + selection (cached; injectable for tests) ───────────────────────────────────────────────

/** Denial dialect per backend — what a kernel-refused file effect looks like on stderr. */
const DENIAL_SIGNATURES: Record<Exclude<LocalBackendId, 'none'>, readonly string[]> = {
	bwrap: ['read-only file system', 'permission denied'],
	seatbelt: ['operation not permitted'],
}

/** Test hooks: replace the platform or a probe (exercise any platform's chain from any host). */
export interface BackendInternals {
	platform?: string
	probeBwrap?: () => boolean
	probeSeatbelt?: () => boolean
}

const PROBE_TIMEOUT_MS = 5_000

/** Functional bwrap probe: can it actually create the read-only profile and run `true` under it? */
function defaultProbeBwrap(): boolean {
	const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
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
			const probe = rung === 'bwrap' ? (internals.probeBwrap ?? defaultProbeBwrap) : (internals.probeSeatbelt ?? defaultProbeSeatbelt)
			if (probe()) return rung
		}
		return 'none'
	}
	const picked = select()
	if (internals.platform === undefined) cachedBackend = picked // cache only real-platform verdicts
	return picked
}

/** The selected backend's standing claims, for the core Sandbox seam's readonly fields (HostSandbox
 *  surfaces these so Bash's denial classifier knows this host's dialect). No backend ⇒ no claims. */
export function localBackendClaims(): { enforcement?: SandboxEnforcement; denialSignatures?: readonly string[] } {
	const backend = selectLocalBackend()
	if (backend === 'none') return {}
	return { enforcement: 'full', denialSignatures: DENIAL_SIGNATURES[backend] }
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
	return {
		command: wrapCommand(backend, command, policy),
		backend,
		enforcement: 'full',
		denialSignatures: DENIAL_SIGNATURES[backend],
	}
}
