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
  /** ADR-070: the file-effect policy this execution runs under. Backends that understand policy enforce it
   *  in their own dialect; backends that don't (or a call without one) behave as before. Optional so every
   *  existing caller/backends pair keeps working unchanged. */
  policy?: import('./policy').SandboxPolicy
}

export interface ExecResult {
  /** Combined stdout + stderr. */
  output: string
  /** Process exit code (null if killed/aborted). */
  exitCode: number | null
}

/** ADR-070: how completely a backend enforces the policy's promise. 'full' = every promised file effect is
 *  governed by construction (a container, a mount profile). 'partial' = documented boundaries remain (e.g.
 *  a write-fence that cannot cover Everyone-granted objects or hard links) — the UI and the model-facing
 *  docs must state the weaker boundary rather than advertise an absolute one. */
export type SandboxEnforcement = 'full' | 'partial'

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
  /** ADR-070: this backend's honest enforcement claim (see SandboxEnforcement). Absent ⇒ 'full' is assumed
   *  for compatibility (the Docker backend's container boundary genuinely governs execution). */
  readonly enforcement?: SandboxEnforcement
  /** ADR-070: case-insensitive stderr substrings that mean "the sandbox DENIED a file effect" in this
   *  backend's dialect (bwrap: 'read-only file system'; Seatbelt: 'operation not permitted'; …). The tool
   *  layer classifies confined output with these (step 2) so a policy denial is recognized identically
   *  across backends — and never confused with an ordinary command failure. Absent ⇒ no classification. */
  readonly denialSignatures?: readonly string[]
  /** ADR-088 §5: facts about this runtime the model cannot discover cheaply and must not guess — which shell
   *  Bash really runs, whether node/npm exist, the preview port. One line each, rendered under # Environment.
   *  Must be STABLE across turns (cached): it is part of the prompt prefix. Absent ⇒ no lines. */
  readonly environmentFacts?: readonly string[]
  /** Run a shell command inside the isolated environment, streaming output via opts.onData. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Tear down the environment (e.g. stop/remove the container). Safe to call more than once. */
  dispose(): Promise<void>
}
