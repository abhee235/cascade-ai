// terminalSession.ts — an interactive shell inside the project's sandbox container (M7), via the dockerode
// Docker API (pure JS — no native build; cross-platform: auto-detects the daemon socket on macOS/Linux/
// Windows). Server-only; the wrapper relays the PTY stream as `terminalData` BuilderEvents. The shell runs in
// the container, so it's confined exactly like the agent's Bash — the security boundary is the sandbox.

import Docker from 'dockerode'

export interface TerminalHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const docker = new Docker() // auto-detects /var/run/docker.sock (macOS/Linux) or //./pipe/docker_engine (Windows)

/** Open a PTY shell (`sh`) in the given container. Streams output via onData; calls onExit when the shell
 *  ends. Returns handles to write input, resize, and kill. The long-lived container stays up after kill. */
export async function createTerminal(
  containerId: string,
  size: { cols: number; rows: number },
  onData: (chunk: string) => void,
  onExit: () => void,
): Promise<TerminalHandle> {
  const container = docker.getContainer(containerId)
  const exec = await container.exec({
    Cmd: ['sh'],
    WorkingDir: '/workspace',
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ['TERM=xterm-256color'],
  })
  const stream = await exec.start({ hijack: true, stdin: true })
  stream.on('data', (b: Buffer) => onData(b.toString('utf8')))
  stream.on('end', onExit)
  stream.on('error', onExit)
  // Size the PTY to the client's terminal up front; ignore if the exec isn't ready yet.
  exec.resize({ w: size.cols, h: size.rows }).catch(() => {})

  let dead = false
  return {
    write: (data) => {
      if (!dead) stream.write(data)
    },
    resize: (cols, rows) => {
      if (!dead) exec.resize({ w: cols, h: rows }).catch(() => {})
    },
    kill: () => {
      if (dead) return
      dead = true
      stream.end() // ends stdin → `sh` exits; the container (tail -f) keeps running
    },
  }
}
