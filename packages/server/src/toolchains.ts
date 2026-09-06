// toolchains.ts — the toolchain provisioning layer (ADR-070 Part B, step 3).
//
// The clash half of the sandbox problem needs no sandbox: projects must never use — or pollute — the
// user's own toolchains (their Node, their npm cache, their global packages). The mechanism is `mise`
// (a single static binary the packaged app bundles; on a dev machine, PATH or CASCADE_MISE_PATH), with
// EVERYTHING it installs redirected into a Cascade-owned prefix. Projects declare what they need in a
// `mise.toml`, which also makes them reproducible on a second machine: same file, same toolchain.
//
// Wrapper-side on purpose (core knows nothing of toolchains — same rule as Docker, ADR-024): the host
// runtime injects `miseEnv()` into every spawn, so commands resolve `node`/`python`/`go` through mise
// SHIMS in the Cascade prefix when mise is present — and when it is absent, `miseEnv()` is `{}` and the
// host path stays byte-identical to today. The Docker runtime doesn't need any of this: its image IS the
// toolchain, isolated by construction.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const isWindows = process.platform === 'win32'

/** The Cascade-owned prefix everything toolchain-related lives under. Override: CASCADE_TOOLCHAINS_DIR
 *  (tests, portable installs). Default: the per-user app-data area — NOT the project (toolchains are
 *  shared across projects; versions are per-project via mise.toml) and NOT the user's own ~/.local
 *  tool dirs (the whole point is never touching those). */
export function toolchainsDir(): string {
	if (process.env.CASCADE_TOOLCHAINS_DIR) return process.env.CASCADE_TOOLCHAINS_DIR
	const base = isWindows
		? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
		: (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'))
	return join(base, 'Cascade', 'toolchains')
}

/** Probe verdict, cached for the process lifetime (the probe spawns; every exec consults this). */
let cachedMise: string | null | undefined

/** Test hook + config-change hook: forget the cached probe. */
export function resetToolchainCache(): void {
	cachedMise = undefined
}

/**
 * Locate mise, once: kill-switch (CASCADE_MISE=0) → explicit CASCADE_MISE_PATH (what the packaged app
 * sets to its bundled binary) → a previously provisioned copy in the Cascade prefix → a functional PATH
 * probe (`mise --version`, the dev-machine case). Undefined ⇒ the layer is dormant, never an error:
 * the app must stay useful without it (D7, graceful degradation).
 */
export function findMise(): string | undefined {
	if (cachedMise !== undefined) return cachedMise ?? undefined
	if (process.env.CASCADE_MISE === '0' || process.env.CASCADE_MISE === 'off') {
		cachedMise = null
		return undefined
	}
	const exe = isWindows ? 'mise.exe' : 'mise'
	for (const c of [process.env.CASCADE_MISE_PATH, join(toolchainsDir(), 'bin', exe)]) {
		if (c && existsSync(c)) {
			cachedMise = c
			return c
		}
	}
	const probe = spawnSync('mise', ['--version'], { stdio: 'ignore', timeout: 5_000, windowsHide: true })
	cachedMise = probe.status === 0 ? 'mise' : null
	return cachedMise ?? undefined
}

/**
 * The env block that activates the layer for one spawned command. Empty when mise is absent — spreading
 * `{}` keeps the host path byte-identical, so this can be injected unconditionally. When present:
 * every mise dir (data/cache/state/config) is redirected into the Cascade prefix — the user's own
 * ~/.config/mise and ~/.local/share/mise are never read or written, in EITHER direction: their global
 * config must not leak into Cascade projects any more than Cascade may pollute their machine — and the
 * SHIMS directory is prepended to PATH, so `node`/`python`/`cargo` resolve to whatever the project's
 * mise.toml pins (and fall through to the host tool only when mise has nothing for that name).
 */
export function miseEnv(): Record<string, string> {
	const mise = findMise()
	if (!mise) return {}
	const prefix = toolchainsDir()
	const data = join(prefix, 'data')
	// Shims first — then, for an explicitly located binary, ITS directory: a shim is a stub that
	// re-executes `mise`, so a bundled/CASCADE_MISE_PATH binary that isn't on the user PATH would make
	// every shim die with "failed to execute mise: program not found" (measured — the live E2E caught
	// exactly this, and the packaged app is precisely that case). A PATH-located `mise` needs nothing.
	const pathParts = [join(data, 'shims')]
	if (mise !== 'mise') pathParts.push(dirname(mise))
	return {
		MISE_DATA_DIR: data,
		MISE_CACHE_DIR: join(prefix, 'cache'),
		MISE_STATE_DIR: join(prefix, 'state'),
		MISE_CONFIG_DIR: join(prefix, 'config'),
		PATH: `${pathParts.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
	}
}

/**
 * The COMPLETE toolchain env for one host spawn (ADR-070 Part D): mise (when present) plus the BUNDLED
 * portable Node the desktop shell points at (`CASCADE_NODE_DIR`, the directory holding `node(.exe)`).
 * PATH order is the whole design: mise shims (a project's pin always wins) → bundled Node (the offline
 * default, so web projects build on first run with no download) → the user's own PATH last — never
 * first, because a user's Node/npm colliding with the project's is the clash Layer B exists to remove.
 * Empty when neither exists, so the spread is byte-identical to today's host path.
 */
export function toolchainEnv(): Record<string, string> {
	const env = miseEnv()
	const nodeDir = process.env.CASCADE_NODE_DIR
	if (!nodeDir || !existsSync(nodeDir)) return env
	if (!env.PATH) return { PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}` }
	// miseEnv's PATH is `<shims>[<delimiter><mise-bin>]<delimiter><host PATH>`; slot the bundled node in
	// right AFTER the mise-managed prefix and BEFORE the host PATH.
	const hostPath = process.env.PATH ?? ''
	const misePrefix = hostPath ? env.PATH.slice(0, env.PATH.length - hostPath.length) : env.PATH
	return { ...env, PATH: `${misePrefix}${nodeDir}${delimiter}${hostPath}` }
}

/** The default declaration a scaffolded project gets: Node pinned to LTS — enough to make "works on my
 *  machine" reproducible without opining on anything else. The agent edits this file (it's project
 *  content) when a task needs Python/Go/Rust; `mise install` then provisions into the Cascade prefix. */
const DEFAULT_MISE_TOML = `# Toolchains this project needs — provisioned per-project by mise into Cascade's own prefix (ADR-070).
# Add tools as the project needs them, e.g.:  python = "3.12"  ·  go = "1.23"  ·  rust = "latest"
[tools]
node = "lts"
`

/**
 * Ensure the project DECLARES its toolchains. Written only when mise is actually available (a config
 * for a dormant layer would be clutter in every project) and only when absent — the file is project
 * content the agent and user own from then on. Returns true when this call created it.
 */
export function ensureProjectToolchainConfig(projectDir: string): boolean {
	if (!findMise()) return false
	if (existsSync(join(projectDir, 'mise.toml')) || existsSync(join(projectDir, '.mise.toml'))) return false
	try {
		writeFileSync(join(projectDir, 'mise.toml'), DEFAULT_MISE_TOML)
		return true
	} catch {
		return false // an unwritable project loses pinning, not the install
	}
}

/**
 * Provision the project's declared toolchains (`mise install` in the project dir, everything landing in
 * the Cascade prefix). Best-effort by design: no mise or no declaration ⇒ true (nothing to do); a
 * failed install returns false and the caller proceeds — npm on the host toolchain is degraded, not
 * broken, and the install output (streamed via onData) says what happened.
 */
export function installProjectToolchains(projectDir: string, onData?: (chunk: string) => void): Promise<boolean> {
	const mise = findMise()
	if (!mise) return Promise.resolve(true)
	if (!existsSync(join(projectDir, 'mise.toml')) && !existsSync(join(projectDir, '.mise.toml'))) return Promise.resolve(true)
	return new Promise((resolve) => {
		// try/catch as well as the 'error' listener: on Windows, spawning a non-executable file throws
		// EFTYPE SYNCHRONOUSLY (measured in the test suite) instead of emitting 'error' like POSIX does.
		try {
			const child = spawn(mise, ['install'], {
				cwd: projectDir,
				env: { ...process.env, ...miseEnv() },
				windowsHide: true,
			})
			const take = (c: Buffer) => onData?.(String(c))
			child.stdout?.on('data', take)
			child.stderr?.on('data', take)
			child.on('error', () => resolve(false))
			child.on('exit', (code) => resolve(code === 0))
		} catch {
			resolve(false)
		}
	})
}
