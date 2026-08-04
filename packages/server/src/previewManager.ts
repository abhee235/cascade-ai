// previewManager.ts — live preview (M3). Runs the project's dev server INSIDE its Docker container and
// surfaces the URL the web app iframes. The container already publishes the dev port to a host port
// (DockerSandbox), so once `npm run dev` is up we just poll that host URL. Server-only; emits `preview`
// status over the protocol.

import type { DockerSandbox } from './dockerSandbox.js'

export type PreviewStatus = 'installing' | 'starting' | 'running' | 'error' | 'stopped'
export interface PreviewState {
  status: PreviewStatus
  url?: string
  /** Why it failed, in the user's words — e.g. port drift ("started on 5174, only 5173 is published").
   *  Without this the pane showed a bare "Preview unreachable" and the cause stayed invisible. */
  error?: string
}

/** Where the detached dev server's stdout/stderr is redirected inside the container, so the Console pane
 *  can tail it (M5). Detached `npm run dev` would otherwise discard its output. */
const DEV_LOG = '/tmp/cascade-dev.log'
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '') // Vite colorizes output; the pane is plain text

export class PreviewManager {
  private readonly states = new Map<string, PreviewState>()

  /** @param hmrClientPort the port the browser reaches the dev server on (the PreviewProxy port). The HMR
   *  websocket connects there so it rides the same stable origin as the iframe. Falls back to the direct
   *  host port if not given. */
  constructor(private readonly hmrClientPort?: number) {}

  state(projectId: string): PreviewState | undefined {
    return this.states.get(projectId)
  }

  /** Stream the dev server's log file line-by-line (M5). Returns a stop fn (aborts the `tail` exec). Sends
   *  the last 300 lines first (backlog), then follows. Server-only; the wrapper relays lines as `log` events. */
  tail(_projectId: string, sandbox: DockerSandbox, onLine: (line: string) => void): () => void {
    const ctrl = new AbortController()
    let buf = ''
    void sandbox
      .exec(`tail -n 300 -f ${DEV_LOG} 2>/dev/null`, {
        signal: ctrl.signal,
        onData: (chunk) => {
          buf += chunk
          const lines = buf.split('\n')
          buf = lines.pop() ?? '' // keep the partial last line for the next chunk
          for (const l of lines) onLine(stripAnsi(l))
        },
      })
      .catch(() => {}) // aborted, or the container went away — both fine
    return () => ctrl.abort()
  }

  /** Install deps (first time), start the dev server detached, and wait for the host port to answer. */
  async start(projectId: string, sandbox: DockerSandbox, emit: (s: PreviewState) => void): Promise<void> {
    const cached = this.states.get(projectId)
    if (cached?.status === 'running' && cached.url) return emit(cached)

    const set = (s: PreviewState) => {
      this.states.set(projectId, s)
      emit(s)
    }
    try {
      set({ status: 'installing' })
      // Check node_modules is POPULATED, not just present: it lives in a Docker volume (DockerSandbox) that
      // exists-but-empty before the first install, so a bare `[ -d node_modules ]` would wrongly skip install.
      const has = await sandbox.exec('[ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no')
      if (!has.output.includes('yes')) {
        const inst = await sandbox.exec('npm install --no-audit --no-fund')
        if (inst.exitCode !== 0) return set({ status: 'error' })
      }

      set({ status: 'starting' })
      // The host port must be known BEFORE starting dev: Vite bakes the HMR websocket port into the client,
      // and the iframe is served on this (random) published host port — not the container's 5173. We pass it
      // as VITE_HMR_CLIENT_PORT so the HMR socket connects back through the right port. CHOKIDAR_USEPOLLING
      // makes Vite detect file edits on the Windows Docker bind mount (inotify events don't cross it).
      const hostPort = await sandbox.getHostPort()
      // HMR connects on the proxy port (stable origin) when a proxy is in use, else the direct host port.
      const hmrPort = this.hmrClientPort ?? hostPort
      // ADR-066: reap any dev/API processes a PRIOR submit's Bash left running before starting a fresh one.
      // Measured (luna full-stack run): orphaned vite + a stale API server accumulated across submits,
      // causing port conflicts and smoke tests that hit the wrong process. Best-effort; harmless if none.
      await sandbox.exec('pkill -f "vite" ; pkill -f "tsx.*server" ; true').catch(() => {})
      // Redirect output to DEV_LOG so the Console pane can tail it (detached exec discards stdout otherwise).
      await sandbox.execDetached(`CHOKIDAR_USEPOLLING=true VITE_HMR_CLIENT_PORT=${hmrPort} npm run dev > ${DEV_LOG} 2>&1`)
      const url = `http://localhost:${hostPort}` // direct url; wsServer rewrites it to the proxy origin
      const up = await waitForHttp(url, 60_000)
      if (up) {
        set({ status: 'running', url })
        return
      }
      // PORT DRIFT (measured, 3D Solar build 2026-08-03): the container publishes exactly ONE port
      // (-p 0:5173). If Vite finds 5173 busy it silently takes 5174 — which is published NOWHERE, so the
      // preview is unreachable from the host and no URL the user could type would reach it either. The dev
      // log states the truth ("Local: http://localhost:5174/"), so read it and say so precisely instead of
      // showing a bare "error" that sent a model into a 30-minute cache-nuking loop.
      const drift = await detectDevPort(sandbox)
      set({
        status: 'error',
        error:
          drift && drift !== DEV_PORT_IN_CONTAINER
            ? `The dev server started on port ${drift}, but only ${DEV_PORT_IN_CONTAINER} is published from the container — so the preview cannot reach it. Something else is holding ${DEV_PORT_IN_CONTAINER} (usually a dev server left over from an earlier run). Stop the preview and start it again to reclaim the port.`
            : 'The dev server did not start. Check the Output/Console pane for its error.',
      })
    } catch {
      set({ status: 'error' })
    }
  }

  stop(projectId: string): void {
    this.states.delete(projectId)
  }
}

/** The container port the sandbox publishes. Anything else is unreachable from the host by construction. */
const DEV_PORT_IN_CONTAINER = Number(process.env.CASCADE_DEV_PORT ?? 5173)

/** The port the dev server ACTUALLY bound, read from its own log ("Local: http://localhost:5174/"), or
 *  undefined when the log says nothing useful. Exported for tests. */
export function parseDevPort(log: string): number | undefined {
  // Vite prints "Local:   http://localhost:5173/"; Next/others print similar "http://localhost:PORT".
  const matches = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/gi)]
  const last = matches[matches.length - 1]
  return last ? Number(last[1]) : undefined
}

async function detectDevPort(sandbox: DockerSandbox): Promise<number | undefined> {
  try {
    const { output } = await sandbox.exec(`tail -40 ${DEV_LOG} 2>/dev/null || true`)
    return parseDevPort(output)
  } catch {
    return undefined
  }
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
