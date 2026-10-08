// projectRuntime.ts — what the PREVIEW needs from wherever a project runs (ADR-081 §4).
//
// `Sandbox` (core) is deliberately tiny: run a command, tear down. The preview needs more — install
// dependencies, start a dev server that OUTLIVES the call, learn which port it landed on, follow its log.
// DockerSandbox grew those as extra methods and PreviewManager imported the concrete class, so the preview
// only existed when Docker did. Host mode is the DEFAULT now, and a desktop install with no live preview
// is not a product.
//
// The important design choice is that these are INTENTS, not shell strings. The old code said
// `pkill -f vite`, `tail -n 300 -f /tmp/cascade-dev.log`, `[ -n "$(ls -A node_modules)" ]` — all POSIX, all
// fine inside a container, and none of which exist on a Windows host, which is the machine this ships to
// first. Docker implements them with the shell it already has; the host implements them with Node APIs and
// needs no shell at all. That also makes the host path STRONGER, not merely portable: stopping a dev server
// by the pid we spawned beats pattern-matching process names, which cannot tell our vite from the user's.

import type { Sandbox } from '@cascade/core'

/** A project's execution environment: core's Sandbox plus what the preview needs. */
export interface ProjectRuntime extends Sandbox {
	/** For the status line, the boundary test's expectations, and the UI badge. */
	readonly kind: 'host' | 'docker' | 'wsl'

	/** Are dependencies installed? Must test POPULATED, not merely present: under Docker `node_modules` is a
	 *  named volume that exists-but-empty before the first install, so a presence check skips it forever. */
	hasDependencies(): Promise<boolean>

	/** `npm install`, streaming progress. Resolves false if it failed. */
	installDependencies(onData?: (chunk: string) => void): Promise<boolean>

	/** The port a BROWSER should use to reach this project's dev server. Docker returns the published host
	 *  port; the host runtime reserves a free one. Known BEFORE the dev server starts, because Vite bakes the
	 *  HMR client port into the bundle it serves. */
	previewPort(): Promise<number>

	/** Start `npm run dev` detached, with its output captured where `devLog`/`followDevLog` can read it.
	 *  Returns once the process has been launched, NOT once it is serving — the caller polls for that. */
	startDev(env: Record<string, string>): Promise<void>

	/** Stop any dev server this runtime started. Best-effort by contract: a preview that cannot be stopped
	 *  must not prevent starting a new one. */
	stopDev(): Promise<void>

	/** ADR-089 §1: has the process startDev launched already EXITED? A dev server never exits on its own, so true
	 *  means the launch failed (measured: `'npm.cmd' is not recognized`, dead in under a second, while the
	 *  callers polled for 30–60 s). Optional: runtimes that cannot tell simply never short-circuit the wait. */
	devExited?(): boolean

	/** The last `lines` lines of the dev server's log, for diagnosing a failed start. '' when there is none. */
	devLog(lines: number): Promise<string>

	/** Follow the dev log, backlog first then live, until `signal` aborts. Drives the Console pane. */
	followDevLog(onLine: (line: string) => void, signal: AbortSignal): void
}

/** Vite colourises its output; the Console pane renders plain text. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * The port the dev server ACTUALLY bound, read from its own log ("Local: http://localhost:5174/").
 *
 * Exists because of a measured failure (3D Solar build, 2026-08-03): Docker publishes exactly one port, and
 * if Vite finds it busy it silently takes the next one — reachable from nowhere. The log states the truth,
 * so the error can name the real cause instead of showing a bare "Preview unreachable".
 */
export function parseDevPort(log: string): number | undefined {
	const matches = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/gi)]
	const last = matches[matches.length - 1]
	return last ? Number(last[1]) : undefined
}

/** Which runtime a project's commands execute in. 'wsl' (ADR-070 step 5, Windows only): commands run
 *  in the cascade-sandbox WSL2 VM with only the project dir mounted — Docker-grade isolation, no Docker. */
export type RuntimeMode = 'host' | 'docker' | 'wsl'

/** ADR-081 §4: host. The app must be useful the moment it is installed; isolation is opt-in. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'host'
