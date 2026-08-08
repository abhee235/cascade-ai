// sandbox/sandbox.ts — a GENERIC execution capability (the only sanctioned core seam for 13.3).
//
// Core stays headless and knows NOTHING about Docker. It only defines the *shape* of "run a command
// somewhere": a frontend/wrapper may inject a Sandbox (via SessionOptions → ToolContext) and the tools
// that execute commands (Bash, later file/exec tools) route through it. When absent, tools run on the host
// (unchanged — what the VS Code extension does). When present, the wrapper decides WHERE (the server
// injects a Docker-backed impl, one container per project). This keeps Docker/isolation entirely in the
// wrapper while letting core's tools be redirected. — see PLAN rule #3.

export interface ExecOptions {
  /** Working directory (host path of the project). A sandbox maps this to its own mount as needed. */
  cwd?: string
  /** Abort the command (wired to the session's Stop). */
  signal?: AbortSignal
  /** Stream combined stdout+stderr chunks live (drives the tool card's progress). */
  onData?: (chunk: string) => void
}

export interface ExecResult {
  /** Combined stdout + stderr. */
  output: string
  /** Process exit code (null if killed/aborted). */
  exitCode: number | null
}

export interface Sandbox {
  /** The path the project is mounted at INSIDE the sandbox (e.g. '/workspace'). The host-side file tools
   *  treat this (and a couple of common aliases) as a synonym for the project root, so a model that addresses
   *  files by the in-sandbox path lands in the project instead of escaping to the host. — ADR-033. */
  readonly root: string
  /**
   * Which shell syntax `exec` actually accepts. Defaults to 'posix' when absent, because that is what a
   * container runs regardless of the host.
   *
   * Load-bearing, not informational: the loop advertises shell guidance in the Bash tool description from
   * this, and a mismatch is expensive. A sandbox that runs commands through the HOST shell on Windows
   * would otherwise be told to use POSIX syntax and open with `mkdir -p`, which cmd.exe rejects — the
   * exact failure the description was written to prevent (measured, Orbit build 2026-07-27).
   */
  readonly shell?: 'posix' | 'win32'
  /** Run a shell command inside the isolated environment, streaming output via opts.onData. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Tear down the environment (e.g. stop/remove the container). Safe to call more than once. */
  dispose(): Promise<void>
}
