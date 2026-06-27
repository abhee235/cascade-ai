// dockerSandbox.ts — a Docker-backed Sandbox (Phase 13.3). This is where ALL Docker knowledge lives;
// @cascade/core only knows the generic `Sandbox` interface and routes Bash through it. One long-lived
// container per project, with the project dir mounted at /workspace; each command is a `docker exec`. The
// agent's shell therefore runs INSIDE the container and cannot touch the host filesystem/network beyond
// the mounted project dir. — see PLAN Step 2 (rule #3).

import { spawn } from 'node:child_process'
import type { ExecOptions, ExecResult, Sandbox } from '@cascade/core'

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

export class DockerSandbox implements Sandbox {
  private containerId?: string
  private starting?: Promise<string>

  constructor(
    private readonly projectDir: string,
    private readonly image = DEFAULT_IMAGE,
  ) {}

  /** Lazily start (once) a long-lived container with the project dir mounted at /workspace. */
  private ensure(): Promise<string> {
    if (this.containerId) return Promise.resolve(this.containerId)
    if (this.starting) return this.starting
    // Docker Desktop on Windows accepts forward-slash drive paths (C:/Users/…).
    const mount = `${this.projectDir.replace(/\\/g, '/')}:/workspace`
    this.starting = dockerRun([
      'run', '-d', '--rm', '-w', '/workspace', '-v', mount, this.image, 'sh', '-c', 'tail -f /dev/null',
    ]).then(({ output, exitCode }) => {
      if (exitCode !== 0) throw new Error(`docker run failed: ${output.trim() || 'unknown error'}`)
      const id = output.trim().split('\n').pop()!.trim()
      this.containerId = id
      return id
    })
    return this.starting
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const id = await this.ensure()
    return dockerRun(['exec', '-w', '/workspace', id, 'sh', '-c', command], { signal: opts.signal, onData: opts.onData })
  }

  async dispose(): Promise<void> {
    const id = this.containerId
    this.containerId = undefined
    this.starting = undefined
    if (id) await dockerRun(['rm', '-f', id]).catch(() => {})
  }
}
