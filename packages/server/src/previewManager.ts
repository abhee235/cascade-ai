// previewManager.ts — live preview (M3). Runs the project's dev server INSIDE its Docker container and
// surfaces the URL the web app iframes. The container already publishes the dev port to a host port
// (DockerSandbox), so once `npm run dev` is up we just poll that host URL. Server-only; emits `preview`
// status over the protocol.

import type { DockerSandbox } from './dockerSandbox.js'

export type PreviewStatus = 'installing' | 'starting' | 'running' | 'error' | 'stopped'
export interface PreviewState {
  status: PreviewStatus
  url?: string
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
      // Redirect output to DEV_LOG so the Console pane can tail it (detached exec discards stdout otherwise).
      await sandbox.execDetached(`CHOKIDAR_USEPOLLING=true VITE_HMR_CLIENT_PORT=${hmrPort} npm run dev > ${DEV_LOG} 2>&1`)
      const url = `http://localhost:${hostPort}` // direct url; wsServer rewrites it to the proxy origin
      const up = await waitForHttp(url, 60_000)
      set(up ? { status: 'running', url } : { status: 'error' })
    } catch {
      set({ status: 'error' })
    }
  }

  stop(projectId: string): void {
    this.states.delete(projectId)
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
