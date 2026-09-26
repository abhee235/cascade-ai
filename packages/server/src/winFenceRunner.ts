// winFenceRunner.ts — the write-fence RUNNER (ADR-070 step 6). Spawned by the win32 rung of
// sandboxBackends as an argv-prefix wrapper — the same shape as bwrap/sandbox-exec, so the backend seam
// needs no special case. It builds the WRITE_RESTRICTED token, redirects the child's TMP/TEMP **and npm's
// cache** into a workspace-private temp dir (so npm/build tools' writes land inside the granted tree rather
// than being denied outside it), spawns the wrapped command under the token, and mirrors its exit code.
//
//   node --import tsx winFenceRunner.ts --workspace <dir> --mode <read-only|workspace-write>
//        [--write-sid <S-1-4-…>] [--temp-dir <dir>] -- <command...>
//
// Every runner-side failure prints `cascade-fence: <detail>` to stderr and exits 127 — the backend's
// runnerFailureSignatures match that, so a runner refusal is NEVER misread as a policy denial (the child
// simply did not run). The command after `--` arrives as ONE element (the backend passes it via argv, no
// reshell), and is handed to cmd.exe (/d /s /c) so shell syntax works.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildRestrictedToken, spawnUnderToken } from './winFence.js'

const RUNNER_FAILURE_EXIT = 127
export const RUNNER_FAILURE_SIGNATURE = 'cascade-fence:'

interface Parsed {
	workspace: string
	mode: 'read-only' | 'workspace-write'
	writeSid?: string
	tempDir?: string
	command: string[]
}

/** Parse the runner argv. Exported so the backend and tests build/verify the exact same contract. */
export function parseRunnerArgs(argv: string[]): Parsed {
	const sep = argv.indexOf('--')
	if (sep === -1) throw new Error('missing `--` separating flags from the command')
	const flags = argv.slice(0, sep)
	const command = argv.slice(sep + 1)
	if (command.length === 0) throw new Error('no command after `--`')
	const get = (name: string): string | undefined => {
		const i = flags.indexOf(name)
		return i !== -1 && i + 1 < flags.length ? flags[i + 1] : undefined
	}
	const workspace = get('--workspace')
	const mode = get('--mode')
	if (!workspace) throw new Error('missing --workspace')
	if (mode !== 'read-only' && mode !== 'workspace-write') throw new Error(`invalid --mode: ${mode}`)
	const writeSid = get('--write-sid')
	if (mode === 'workspace-write' && !writeSid) throw new Error('workspace-write requires --write-sid')
	return { workspace, mode, writeSid, tempDir: get('--temp-dir'), command }
}

/** The child command line for cmd.exe. The command arrives as one element (no reshell); wrap it in
 *  `cmd /d /s /c "…"` — cmd /s strips exactly the outer quote pair and runs the rest verbatim. */
export function buildChildCommandLine(command: string[]): string {
	const joined = command.length === 1 ? command[0] : command.join(' ')
	return `${process.env.ComSpec ?? 'cmd.exe'} /d /s /c "${joined}"`
}

/**
 * Point every default write location a build uses at the workspace-private temp dir the fence ALREADY
 * grants. %TEMP% was redirected from the start; npm's CACHE is a SEPARATE location and was not — measured
 * 2026-09-25 under the real fence:
 *
 *   npm error code EPERM
 *   npm error path C:\\Users\\<u>\\AppData\\Local\\npm-cache\\_cacache\\tmp\\f67bfc73
 *
 * so `npm install` — the first thing any build does — failed outright on the host tier, and the model's
 * only visible recourse was to escalate to danger-full-access for a cache directory. Exactly the same bug
 * the WSL rung had (`EROFS /root/.npm/_cacache`); the two runtimes now answer it the same way. Nothing is
 * widened: this dir is inside the workspace ACE, so it needs no new grant.
 *
 * Exported and returning what it set so a test can pin the contract without Win32. read-only gets nothing —
 * a mode that forbids writes must forbid cache writes too.
 */
export function redirectChildWrites(parsed: Pick<Parsed, 'mode' | 'tempDir'>): Record<string, string> | undefined {
	if (parsed.mode !== 'workspace-write' || !parsed.tempDir) return undefined
	const npmCache = join(parsed.tempDir, 'npm-cache')
	mkdirSync(npmCache, { recursive: true }) // creates tempDir on the way
	// The runner is UNRESTRICTED node (the token binds only the spawned child), so these mkdirs are free,
	// and the child inherits this env — the same mechanism the TMP/TEMP redirect has always relied on.
	const vars = { TMP: parsed.tempDir, TEMP: parsed.tempDir, npm_config_cache: npmCache }
	Object.assign(process.env, vars)
	return vars
}

export function runFence(argv: string[]): number {
	let parsed: Parsed
	try {
		parsed = parseRunnerArgs(argv)
	} catch (e) {
		process.stderr.write(`${RUNNER_FAILURE_SIGNATURE} bad arguments: ${(e as Error).message}\n`)
		return RUNNER_FAILURE_EXIT
	}
	try {
		// Private temp + npm cache INSIDE the workspace (the workspace ACE already grants both).
		redirectChildWrites(parsed)
		const grants = parsed.mode === 'workspace-write' && parsed.writeSid ? [{ dir: parsed.workspace, sid: parsed.writeSid }] : []
		const { token } = buildRestrictedToken({ mode: parsed.mode, grants })
		return spawnUnderToken(token, buildChildCommandLine(parsed.command), parsed.workspace)
	} catch (e) {
		process.stderr.write(`${RUNNER_FAILURE_SIGNATURE} ${(e as Error).message}\n`)
		return RUNNER_FAILURE_EXIT
	}
}

// Entry point when spawned directly (not when imported by a test). `.mjs` is the packaged bundle
// (desktop/build.mts emits resources/sandbox/win32/winFenceRunner.mjs — ADR-070 Part D).
if (/winFenceRunner\.(ts|js|mjs)$/.test(process.argv[1] ?? '')) {
	process.exit(runFence(process.argv.slice(2)))
}
