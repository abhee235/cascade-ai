// previewManager.ts — live preview (M3). Runs the project's dev server in whatever runtime the project has
// and surfaces the URL the web app iframes. Server-only; emits `preview` status over the protocol.
//
// ADR-081 §4: this used to import DockerSandbox and issue POSIX shell strings directly, so the preview
// existed only when Docker did — and host mode is the default now. It talks to a ProjectRuntime instead,
// which states the INTENT (install, start, stop, follow the log) and lets each runtime satisfy it the way
// it can: the container with the shell it already has, the host with Node APIs and no shell at all.

import { parseDevPort, stripAnsi, type ProjectRuntime } from './projectRuntime.js'

export type PreviewStatus = 'installing' | 'starting' | 'running' | 'error' | 'stopped'
export interface PreviewState {
	status: PreviewStatus
	url?: string
	/** Why it failed, in the user's words — e.g. port drift ("started on 5174, only 5173 is published").
	 *  Without this the pane showed a bare "Preview unreachable" and the cause stayed invisible. */
	error?: string
}

export class PreviewManager {
	private readonly states = new Map<string, PreviewState>()

	/** @param hmrClientPort the port the browser reaches the dev server on (the PreviewProxy port). The HMR
	 *  websocket connects there so it rides the same stable origin as the iframe. Falls back to the direct
	 *  host port if not given. */
	constructor(private readonly hmrClientPort?: number) {}

	state(projectId: string): PreviewState | undefined {
		return this.states.get(projectId)
	}

	/** Stream the dev server's log line-by-line (M5). Returns a stop fn. Sends a backlog first, then follows. */
	tail(_projectId: string, runtime: ProjectRuntime, onLine: (line: string) => void): () => void {
		const ctrl = new AbortController()
		runtime.followDevLog(onLine, ctrl.signal)
		return () => ctrl.abort()
	}

	/** Install deps (first time), start the dev server detached, and wait for the port to answer. */
	async start(projectId: string, runtime: ProjectRuntime, emit: (s: PreviewState) => void): Promise<void> {
		const cached = this.states.get(projectId)
		if (cached?.status === 'running' && cached.url) return emit(cached)

		const set = (s: PreviewState) => {
			this.states.set(projectId, s)
			emit(s)
		}
		try {
			set({ status: 'installing' })
			if (!(await runtime.hasDependencies())) {
				if (!(await runtime.installDependencies())) return set({ status: 'error', error: 'npm install failed. Check the Console pane for its output.' })
			}

			set({ status: 'starting' })
			// The port must be known BEFORE starting dev: Vite bakes the HMR websocket port into the client it
			// serves, and under Docker the iframe is served on a published host port, not the container's 5173.
			const hostPort = await runtime.previewPort()
			// HMR connects on the proxy port (a stable origin) when a proxy is in use, else the direct port.
			const hmrPort = this.hmrClientPort ?? hostPort
			// CHOKIDAR_USEPOLLING makes Vite see edits across a Windows→Linux Docker bind mount, where inotify
			// events do not cross. It costs CPU, so the host runtime — which has real file events — omits it.
			const env: Record<string, string> = { VITE_HMR_CLIENT_PORT: String(hmrPort) }
			if (runtime.kind === 'docker') env.CHOKIDAR_USEPOLLING = 'true'
			await runtime.startDev(env)

			const url = `http://localhost:${hostPort}` // direct url; wsServer rewrites it to the proxy origin
			if (await waitForHttp(url, 60_000)) return set({ status: 'running', url })

			// The dev server did not answer where we asked. On the HOST that is recoverable: `--port` is only a
			// request, and a dev script that is not bare `vite` (a `concurrently` wrapper, say) never forwards
			// it. The log states where it really bound, so follow it rather than declaring failure over a flag
			// the project was free to ignore. Under Docker the same drift is fatal by construction — the
			// container publishes exactly one port, so anywhere else is reachable from nowhere.
			if (runtime.kind === 'host') {
				const actual = parseDevPort(await runtime.devLog(40).catch(() => ''))
				if (actual && actual !== hostPort) {
					const actualUrl = `http://localhost:${actual}`
					if (await waitForHttp(actualUrl, 15_000)) return set({ status: 'running', url: actualUrl })
				}
			}

			// PORT DRIFT (measured, 3D Solar build 2026-08-03): under Docker the container publishes exactly
			// ONE port. If Vite finds it busy it silently takes the next — published nowhere, so the preview is
			// unreachable and no URL the user could type would reach it. The dev log states the truth, so read
			// it and say so precisely instead of a bare "error" that once sent a model into a 30-minute
			// cache-nuking loop. The host runtime passes --port explicitly, so drift there means something
			// else took the port between reserving it and Vite binding.
			const log = await runtime.devLog(60).catch(() => '')
			const drift = parseDevPort(log)
			set({
				status: 'error',
				error:
					drift && drift !== hostPort
						? `The dev server started on port ${drift}, but the preview is served from ${hostPort} — so it cannot reach it. Something else is holding ${hostPort} (usually a dev server left over from an earlier run). Stop the preview and start it again to reclaim the port.`
						: // SHOW the reason rather than pointing at a pane. The log already says exactly what went
							// wrong ("Cannot find package '@tailwindcss/vite'"), and "check the Output pane" turns a
							// one-line answer into a hunt — measured: it read as "the server won't start" when the
							// server was fine and a dependency was missing.
							(devServerError(log) ?? 'The dev server did not start. Check the Output/Console pane for its error.'),
			})
		} catch {
			set({ status: 'error' })
		}
	}

	stop(projectId: string): void {
		this.states.delete(projectId)
	}
}

export { parseDevPort } // re-exported: the port-drift parser's tests import it from here

/**
 * The one line of a dev-server log worth putting in front of a user.
 *
 * Vite's failures are verbose — a code frame, a resolver trace, a Node stack — but the sentence that
 * explains them is short and near the end. Searched newest-first so a retry's error wins over the previous
 * attempt's, and ANSI is stripped because this goes into a UI label, not a terminal.
 */
export function devServerError(log: string): string | undefined {
	const lines = stripAnsi(log)
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]
		// Skip stack frames and Vite's box-drawing code frames — they are context, not the cause.
		if (/^at\s|^[╭│╰─┬]/.test(l)) continue
		const m = l.match(/(Cannot find (?:package|module) .+?)(?:\s+imported|$)/i) ?? l.match(/^(?:Error:\s*)?(.*(?:is not recognized|EADDRINUSE|permission denied|ENOENT.*).*)$/i) ?? l.match(/^error (?:when |while )?(.+)$/i)
		if (m) return m[1].slice(0, 300)
	}
	return undefined
}

/** Poll a URL until it answers (any HTTP response = the dev server is listening) or we time out. */
async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(2000) })
			return true
		} catch {
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
	return false
}
