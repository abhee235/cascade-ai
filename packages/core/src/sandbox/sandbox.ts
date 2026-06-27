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
  /** Run a shell command inside the isolated environment, streaming output via opts.onData. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Tear down the environment (e.g. stop/remove the container). Safe to call more than once. */
  dispose(): Promise<void>
}
