// dockerSandbox.ts — a Docker-backed Sandbox (Phase 13.3). This is where ALL Docker knowledge lives;
// @cascade/core only knows the generic `Sandbox` interface and routes Bash through it. One long-lived
// container per project, with the project dir mounted at /workspace; each command is a `docker exec`. The
// agent's shell therefore runs INSIDE the container and cannot touch the host filesystem/network beyond
// the mounted project dir. — see PLAN Step 2 (rule #3).

import { spawn } from 'node:child_process'
import type { ExecOptions, ExecResult } from '@cascade/core'
import { type ProjectRuntime, stripAnsi } from './projectRuntime.js'

/** Where the detached dev server's output is redirected INSIDE the container, so the Console pane can
 *  follow it — a detached `docker exec` discards stdout otherwise. */
const DEV_LOG = '/tmp/cascade-dev.log'

const DEFAULT_IMAGE = process.env.CASCADE_DOCKER_IMAGE ?? 'node:20-alpine'

/** Run a docker CLI command, capturing combined output. */
function dockerRun(args: string[], opts: { signal?: AbortSignal; onData?: (s: string) => void } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { signal: opts.signal })
    let output = ''
    const onData = (b: Buffer) => {
      const s = b.toString()
      output += s
      opts.onData?.(s)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ output: `${output}${e.code === 'ENOENT' ? 'docker not found on PATH' : e.message}`, exitCode: null }),
    )
    child.on('close', (code) => resolve({ output, exitCode: code }))
  })
}

/** Is Docker installed and the daemon reachable? Checked once before wiring sandboxes. */
export async function dockerAvailable(): Promise<boolean> {
  const { exitCode } = await dockerRun(['version', '--format', '{{.Server.Version}}'])
  return exitCode === 0
}

/** The PREVIEW owns the dev server (PreviewManager starts it on the one published port and the proxy
 *  points there). A model-started server is invisible at best and unreachable at worst: the container
 *  publishes exactly one port, so a second Vite silently taking 5174 can never be reached from the host —
 *  measured (3D Solar build, 2026-08-03), that produced "Preview unreachable" and a 30-minute loop of
 *  restart-and-nuke. Refuse it with the alternative, the same shape as the Bash content-write/kill guards.
 *  Detached starts (execDetached) are OURS and bypass this — it only guards the model's `exec` path. */
const DEV_SERVER_RE = /(^|[;&|]|&&)\s*(npx\s+)?(vite|next|nuxt)\b(?!.*\b(build|preview)\b)|(^|[;&|]|&&)\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/i

export function devServerRefusal(command: string, kind: 'docker' | 'host' | 'wsl' = 'docker'): string | undefined {
  if (!DEV_SERVER_RE.test(command)) return undefined
  // ADR-089 §4: the container text below was false in host mode (no container) and claimed a server was running
  // when the launch had failed — sending the agent back to a Browser tool that sent it here.
  if (kind !== 'docker')
    return (
      'Refused: the Preview pane owns the dev server — a second one would fight it for the port. Use ' +
      'Browser {op:"open"}: it starts the dev server and, if it cannot start, returns the error from its log. Fix ' +
      'that error, then open again. Use Bash for `npm run build`, `npx tsc --noEmit` and tests.'
    )
  return (
    'Refused: the dev server is managed by the Preview pane — it is already running on the one port this ' +
    'container publishes, and a second server would bind a port that is published NOWHERE (unreachable from ' +
    'the browser, which is exactly how a previous build lost its preview for 30 minutes). To see your changes: ' +
    'they hot-reload automatically — just look at the Preview. If it seems stuck, stop and start the Preview. ' +
    'Use Bash for `npm run build`, `npx tsc --noEmit` and tests instead.'
  )
}

/** The dev-server port the container publishes (the scaffold runs `vite --host --port 5173`). */
const DEV_PORT = Number(process.env.CASCADE_DEV_PORT ?? 5173)

// M7 security: confine the sandbox so a terminal user — or a CSWSH hijacker — can't exhaust or escape the host.
// We add resource + privilege limits that DON'T break the dev workflow: we deliberately skip `--read-only`
// (npm/tmp writes), `--network none` (npm install needs the registry) and non-root (bind-mount perms).
// Env-overridable for tuning. Identical flags on macOS/Linux/Windows.
const HARDENING = [
  '--pids-limit', process.env.CASCADE_PIDS ?? '512', // fork-bomb cap
  '--memory', process.env.CASCADE_MEM ?? '2g', // OOM-DoS cap (generous so builds don't get killed)
  '--cpus', process.env.CASCADE_CPUS ?? '2', // runaway-compute cap
  '--security-opt', 'no-new-privileges', // block setuid privilege escalation
  '--cap-drop', 'ALL', // node/npm/vite need no Linux capabilities
]

/** Label stamped on every sandbox container, so we can sweep our own (and only our own) leftovers. */
const SANDBOX_LABEL = 'cascade.sandbox'

/** Remove any leftover sandbox containers (filtered by our label). Sandbox containers are `--rm` but stay
 *  alive via `tail -f`, so a previous server run — especially one hard-killed — leaves them orphaned. Run on
 *  startup (clean slate; the project dirs are bind-mounted so nothing is lost) and on graceful shutdown. */
export async function sweepSandboxContainers(): Promise<number> {
  const { output } = await dockerRun(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`])
  const ids = output.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  if (ids.length) await dockerRun(['rm', '-f', ...ids])
  return ids.length
}

export class DockerSandbox implements ProjectRuntime {
  readonly kind = 'docker' as const
  /** A container runs POSIX sh whatever the host is. Stated explicitly rather than left to the default,
   *  because the host runtime's answer differs and the two sit side by side. */
  readonly shell = 'posix' as const
  /** In-sandbox mount point of the project (the `-w` / `-v …:/workspace` below). The host file tools treat
   *  this as a synonym for the project root so the model's in-container paths resolve into the project. */
  readonly root = '/workspace'
  /** ADR-070: the container boundary governs execution by construction — host writes are limited to the
   *  bind-mounted project dir, which IS the workspace-write promise. Declared, not assumed. */
  readonly enforcement = 'full' as const
  /** ADR-070: how a denied file effect reads inside the container (root-squashed mounts, read-only FS
   *  images). Consumed by the tool layer's denial classification (step 2). */
  readonly denialSignatures = ['permission denied', 'read-only file system'] as const
  private containerId?: string
  private starting?: Promise<string>
  private hostPort?: number

  constructor(
    private readonly projectDir: string,
    private readonly image = DEFAULT_IMAGE,
  ) {}

  /** Lazily start (once) a long-lived container with the project dir mounted at /workspace and the dev
   *  port published to a Docker-assigned host port (so live preview works whenever the container is up). */
  private ensure(): Promise<string> {
    if (this.containerId) return Promise.resolve(this.containerId)
    if (this.starting) return this.starting
    // Docker Desktop on Windows accepts forward-slash drive paths (C:/Users/…).
    const projectDir = this.projectDir.replace(/\\/g, '/')
    const mount = `${projectDir}:/workspace`
    // CRITICAL: keep node_modules OFF the bind mount. npm writes thousands of tiny files and does atomic
    // renames, which are pathologically slow — and can outright HANG — on a Windows→Linux Docker bind mount.
    // A named Docker volume shadows /workspace/node_modules with the fast container filesystem, so installs
    // are quick and survive container restarts (install once per project). Source files stay bind-mounted so
    // the agent's edits + Vite still see them.
    const nmVolume = `cascade-nm-${(projectDir.split('/').pop() || 'project').replace(/[^a-zA-Z0-9_.-]/g, '-')}`
    this.starting = dockerRun([
      'run', '-d', '--rm', ...HARDENING, '--label', `${SANDBOX_LABEL}=1`, '-w', '/workspace', '-v', mount, '-v', `${nmVolume}:/workspace/node_modules`, '-p', `0:${DEV_PORT}`, this.image, 'sh', '-c', 'tail -f /dev/null',
    ]).then(async ({ output, exitCode }) => {
      if (exitCode !== 0) throw new Error(`docker run failed: ${output.trim() || 'unknown error'}`)
      const id = output.trim().split('\n').pop()!.trim()
      this.containerId = id
      // Ask Docker which host port it bound (race-free vs picking our own): `0.0.0.0:49160`.
      const { output: portOut } = await dockerRun(['port', id, String(DEV_PORT)])
      const m = portOut.match(/:(\d+)\s*$/m)
      if (m) this.hostPort = Number(m[1])
      return id
    })
    return this.starting
  }

  /** "No such container" / "is not running" from `docker exec` means our cached container id is STALE — the
   *  container vanished mid-session. It's `--rm`, so anything that stops it (Docker Desktop/WSL restart on a
   *  system sleep, a daemon restart, an OOM) also REMOVES it, and `ensure()` would otherwise keep handing back
   *  the dead id forever — every Bash call failing identically while the model builds blind (observed: a whole
   *  60-min build where all 9 shell calls returned "No such container"). Detect it so exec can self-heal. */
  private isStaleContainer(res: ExecResult): boolean {
    return res.exitCode !== 0 && /No such container|is not running|No such object/i.test(res.output)
  }

  /** Run a `docker exec` and, if the container turns out to be gone, drop the cached id, start a FRESH one,
   *  and retry ONCE. Safe because the workspace survives: source is bind-mounted and node_modules lives on a
   *  named volume — a new container re-mounts both, so no install/edit is lost across the recreate. */
  private async execWithRecovery(prefix: string[], command: string, opts: { signal?: AbortSignal; onData?: (s: string) => void } = {}): Promise<ExecResult> {
    const id = await this.ensure()
    const res = await dockerRun([...prefix, id, 'sh', '-c', command], opts)
    if (!this.isStaleContainer(res)) return res
    this.containerId = undefined // force ensure() to start a new container next call
    this.starting = undefined
    this.hostPort = undefined
    const freshId = await this.ensure()
    return dockerRun([...prefix, freshId, 'sh', '-c', command], opts)
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const owned = devServerRefusal(command)
    if (owned) return { output: owned, exitCode: 1 }
    return this.execWithRecovery(['exec', '-w', '/workspace'], command, { signal: opts.signal, onData: opts.onData })
  }

  /** Start a long-lived command in the background (e.g. the dev server) and return immediately. */
  async execDetached(command: string): Promise<void> {
    await this.execWithRecovery(['exec', '-d', '-w', '/workspace'], command)
  }

  /** The host port mapped to the container's dev port (ensures the container is up). For live preview. */
  async getHostPort(): Promise<number> {
    await this.ensure()
    if (!this.hostPort) throw new Error('No published preview port')
    return this.hostPort
  }

  // ── ProjectRuntime: the preview's intents, in the shell this runtime already has ────────────────────

  /** POPULATED, not merely present: node_modules is a named volume that exists-but-empty before the first
   *  install, so a bare `[ -d node_modules ]` would skip installing forever. */
  async hasDependencies(): Promise<boolean> {
    const has = await this.exec('[ -n "$(ls -A node_modules 2>/dev/null)" ] && echo yes || echo no')
    return has.output.includes('yes')
  }

  async installDependencies(onData?: (chunk: string) => void): Promise<boolean> {
    const res = await this.exec('npm install --no-audit --no-fund', { onData })
    return res.exitCode === 0
  }

  /** The published host port — Docker chose it when the container started, so this is race-free. */
  async previewPort(): Promise<number> {
    return this.getHostPort()
  }

  async startDev(env: Record<string, string>): Promise<void> {
    await this.stopDev()
    const prefix = Object.entries(env)
      .map(([k, v]) => k + '=' + v)
      .join(' ')
    const cmd = (prefix ? prefix + ' ' : '') + 'npm run dev > ' + DEV_LOG + ' 2>&1'
    await this.execDetached(cmd)
  }

  /** ADR-066: reap dev/API processes a PRIOR submit's Bash left running. Measured (luna full-stack run):
   *  orphaned vite and a stale API server accumulated across submits, causing port conflicts and smoke
   *  tests that hit the wrong process. Matching by NAME is acceptable here and only here — the container
   *  holds nothing but this project, so there is no bystander process to hit. The host runtime cannot make
   *  that assumption and kills by pid instead. */
  async stopDev(): Promise<void> {
    await this.exec('pkill -f "vite" ; pkill -f "tsx.*server" ; true').catch(() => {})
  }

  async devLog(lines: number): Promise<string> {
    const { output } = await this.exec('tail -' + lines + ' ' + DEV_LOG + ' 2>/dev/null || true')
    return output
  }

  followDevLog(onLine: (line: string) => void, signal: AbortSignal): void {
    let buf = ''
    void this.exec('tail -n 300 -f ' + DEV_LOG + ' 2>/dev/null', {
      signal,
      onData: (chunk) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? '' // keep the partial last line for the next chunk
        for (const l of lines) onLine(stripAnsi(l))
      },
    }).catch(() => {}) // aborted, or the container went away — both fine
  }

  /** The running container's id (ensures it's up). Used by the integrated terminal (M7) to exec a shell. */
  async getContainerId(): Promise<string> {
    return this.ensure()
  }

  async dispose(): Promise<void> {
    const id = this.containerId
    this.containerId = undefined
    this.starting = undefined
    if (id) await dockerRun(['rm', '-f', id]).catch(() => {})
  }
}
