// tools/builtins/Bash.ts — run a shell command, streaming its output.
//
// First tool whose flags depend on the INPUT (the Phase-6 lesson's payoff): `ls`/`cat` are read-only and
// concurrency-safe, but `rm`/`npm i` mutate — so isReadOnly inspects the command. And it's the first tool
// that produces output over TIME, so it streams via onProgress and must die on ctx.abortSignal.

import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  command: z.string().describe('The shell command to run (executed via the platform shell).'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional timeout in milliseconds (default 120000 = 2 min, max 600000 = 10 min). The command is killed if it runs longer.'),
})

// ADR-037: a weak model leans on the tool description to know WHEN and HOW to use Bash. It covers the
// git-safety protocol, tool-preference, quoting, interactivity, and parallelism, condensed
// for a local model and Cascade's sandbox. Descriptions are advertised EVERY request, so like the system prompt
// they are TIER-SIZED (the description is a function of the window tier — toolRegistry.descriptionOf).
//
// PLATFORM-AWARE (per-shell guidance): the EXECUTION TARGET decides the syntax —
// a Docker sandbox always runs POSIX sh regardless of host; the host path is cmd.exe on Windows and /bin/sh
// elsewhere. The registry passes that target (`exec`) into the description fn (ADR-037 extension). Measured
// (Orbit build, 2026-07-27): the model's FIRST Bash call was `mkdir -p …`, a bash-ism that fails on cmd.exe;
// it burned a recovery turn discovering the shell by trial. Tell it up front. Stable per session, so the
// description stays cache-stable.
type ExecPlatform = 'win32' | 'posix'
const shellNoteFull = (exec: ExecPlatform): string =>
  exec === 'win32'
    ? `- Commands run via Windows cmd.exe, NOT bash. Use Windows syntax: \`mkdir a\\b\` (no -p; it creates parents), \`2>nul\` (not /dev/null), \`rmdir /s /q\` (not rm -rf), \`copy\`/\`move\`, \`%VAR%\`. No bash-isms: no \`export\`, no \`$( )\`, no heredocs, no single-quoted arguments (use double quotes).
- A dev server or watcher started here BLOCKS until the timeout kills it — this tool cannot host long-running processes. Start it detached instead: \`start /b cmd /c "npm run dev > dev.log 2>&1"\`, then verify with \`curl http://localhost:<port>\` and Read dev.log for errors.`
    : `- Commands run via /bin/sh. Quote arguments containing special characters ($, backticks, parentheses, ;, |, &, !): single quotes '…' pass text literally (but cannot contain a literal single quote); prefer double quotes with inner \\" escaping when unsure. For multi-line text use a heredoc.
- A dev server or watcher started here BLOCKS until the timeout kills it — this tool cannot host long-running processes. Start it detached instead: \`nohup npm run dev > dev.log 2>&1 &\`, then verify with \`curl http://localhost:<port>\` and Read dev.log for errors.`
const shellNoteLean = (exec: ExecPlatform): string =>
  exec === 'win32'
    ? ` Windows cmd.exe syntax (mkdir without -p, 2>nul, no bash-isms, double quotes). Dev servers BLOCK — start detached: start /b cmd /c "npm run dev > dev.log 2>&1".`
    : ` Runs via /bin/sh — quote special characters. Dev servers BLOCK — start detached: nohup npm run dev > dev.log 2>&1 &.`

const descriptionFull = (exec: ExecPlatform) => `Run a shell command in the project and return its combined stdout/stderr. Use it for real shell work — building, running tests, installing dependencies, git, and running scripts.

Prefer the dedicated tools over Bash so the user can review your work:
- Read a file with Read (not cat/head/tail); change one with Edit (not sed/awk); create one with Write (not echo > or heredoc).
- Find files by name with Glob (not find/ls); search file contents with Grep (not grep/rg).
Reserve Bash for commands that genuinely need a shell.

Execution notes:
${shellNoteFull(exec)}
- The working directory persists between calls, but shell state (env vars, cd) does NOT — prefer absolute or project-relative paths over \`cd\`. Quote paths that contain spaces.
- Do NOT run interactive commands (they hang): nothing that waits for input, such as \`git add -i\` or \`git rebase -i\`.
- Multiple commands: if independent, send several Bash calls in ONE message (they run in parallel); if they depend on each other, chain them with \`&&\` in a single call. Don't separate commands with newlines.
- Long output is shortened to keep BOTH the start AND the end (the middle is dropped, marked \`[N chars omitted]\`), and any very long single line is trimmed — so the exit line / error summary at the end is preserved. A non-zero exit is returned as an error — read it and fix the cause.
- Each command times out after 120s by default (max 600000 ms). For a command you expect to be slow (a big install, a long test run), pass a larger \`timeout\`; if one times out, rerun with a larger \`timeout\` or narrow it.

Git safety (only when the user asks you to commit):
- Only commit when explicitly asked. Create a NEW commit — never \`--amend\` unless asked (when a pre-commit hook fails there is no new commit, so --amend would change the previous one).
- Don't use git commands that throw work away (\`push --force\`, \`reset --hard\`, \`checkout .\`, \`clean -f\`, deleting a branch) unless the user asks for them. Never skip hooks (\`--no-verify\`).
- Stage specific files by name rather than \`git add -A\`, to avoid committing secrets (.env) or junk.`

// lean (32k/64k): every load-bearing rule, one line each — no elaboration.
const descriptionLean = (exec: ExecPlatform) => `Run a shell command (build, test, install, git, scripts); returns stdout+stderr.${shellNoteLean(exec)} Prefer the dedicated tools: Read (not cat), Edit (not sed), Write (not echo>), Glob (not find), Grep (not grep/rg). No interactive commands (they hang). Independent commands: separate parallel calls; dependent: chain with &&. Shell state doesn't persist between calls — avoid cd. Times out after 120s (pass a larger \`timeout\` in ms, max 600000, for slow commands). Long output keeps the start+end (middle dropped). Git: only commit when asked; new commits (no --amend); no destructive commands (push --force, reset --hard) or --no-verify unless explicitly asked; stage files by name.`

// minimal (<24k): the two rules that prevent real damage.
const BASH_DESCRIPTION_MINIMAL = `Run a shell command (build/test/git); returns output. Prefer Read/Edit/Write/Glob/Grep for file work. No interactive commands. Git: only commit when asked; never destructive commands (--force, reset --hard, --no-verify) unless explicitly asked.`

const bashDescription = (tier: 'minimal' | 'lean' | 'full', exec?: ExecPlatform): string => {
  // Default to the HOST platform when the caller doesn't say (standalone registry use); the loop passes
  // the real execution target (sandbox ⇒ posix).
  const e: ExecPlatform = exec ?? (process.platform === 'win32' ? 'win32' : 'posix')
  return tier === 'full' ? descriptionFull(e) : tier === 'lean' ? descriptionLean(e) : BASH_DESCRIPTION_MINIMAL
}

// Conservative heuristic: read-only ONLY if every piped/chained segment leads with a known safe command.
// Anything unrecognized is treated as a mutation (fail-safe) — the read-only flag is input-dependent.
const SAFE = [
  /^ls\b/, /^dir\b/, /^pwd\b/, /^echo\b/, /^cat\b/, /^type\b/, /^head\b/, /^tail\b/, /^wc\b/,
  /^grep\b/, /^find\b/, /^whoami\b/, /^date\b/, /^which\b/, /^where\b/, /^git (status|log|diff|show|branch)\b/,
]
function isReadOnlyCommand(command: string): boolean {
  const segments = command.split(/[;&|]+/).map((s) => s.trim()).filter(Boolean)
  return segments.length > 0 && segments.every((seg) => SAFE.some((re) => re.test(seg)))
}

// ADR-045: timeout defaults (ms): 2 min default, 10 min max.
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

// ADR-045: output budget. We keep BOTH the head AND the tail (dropping the middle) — better than
// head-only truncation, because a failing command's signal (the error summary, the stack trace, the exit
// line) is usually at the END. Head gives the command context; tail gives the verdict.
const HEAD = 12_000 // chars kept from the start
const TAIL = 15_000 // chars kept from the end (tail-favoured — that's where failures land)
const MAX_LINE = 2_000 // a single line longer than this is shortened (minified bundles / base64 blobs)

/** Shorten any single line past MAX_LINE so one pathological line can't dominate the (already bounded) view. */
function capLongLines(text: string): string {
  if (!text.includes('\n') && text.length <= MAX_LINE) return text
  return text
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [+${l.length - MAX_LINE} chars]` : l))
    .join('\n')
}

// A bounded accumulator that retains the first HEAD chars and the last TAIL chars of a stream regardless of
// total size — so a 5 GB `cat` can't blow memory or the context window, yet we still keep the ends. Works for
// both a live host stream (many push()es) and the sandbox path (one push of the whole string).
class BoundedOutput {
  private head = ''
  private tail = ''
  private headDone = false
  private total = 0
  push(s: string): void {
    this.total += s.length
    if (!this.headDone) {
      const room = HEAD - this.head.length
      if (s.length <= room) {
        this.head += s
        return
      }
      this.head += s.slice(0, room)
      s = s.slice(room)
      this.headDone = true
    }
    this.tail += s
    if (this.tail.length > TAIL) this.tail = this.tail.slice(-TAIL)
  }
  toString(): string {
    if (!this.headDone) return capLongLines(this.head) // whole output fit within HEAD
    const omitted = this.total - this.head.length - this.tail.length
    if (omitted <= 0) return capLongLines(this.head + this.tail) // head+tail cover everything, no gap
    return `${capLongLines(this.head)}\n\n... [${omitted} chars omitted] ...\n\n${capLongLines(this.tail)}`
  }
}

export const BashTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Bash',
  description: bashDescription, // tier-sized (ADR-037): rich on 128k+, essentials on small windows
  inputSchema,
  activitySummary: (input) => `Running: ${input.command.length > 60 ? `${input.command.slice(0, 60)}…` : input.command}`,
  isReadOnly: (input) => isReadOnlyCommand(input.command),
  isConcurrencySafe: (input) => isReadOnlyCommand(input.command), // safe commands can parallelize; mutating ones run solo

  async call(input, ctx, onProgress) {
    // ADR-045: give every command a deadline. A weak model that fires a command which waits for input (or
    // loops forever) would otherwise hang the whole turn with no recovery. One AbortController drives the
    // child; it trips on EITHER the timer OR the session's Stop, and a flag tells the two apart so the model
    // gets an actionable "timed out" message (→ it can rerun with a bigger timeout) vs a silent kill.
    const timeoutMs = Math.min(input.timeout && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, timeoutMs)
    const onUserAbort = () => ctl.abort()
    if (ctx.abortSignal.aborted) ctl.abort()
    else ctx.abortSignal.addEventListener('abort', onUserAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onUserAbort)
    }
    const timeoutLabel = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
    const timeoutMsg = `[timed out after ${timeoutLabel} — the command was killed. Rerun with a larger \`timeout\` (up to ${MAX_TIMEOUT_MS} ms) or narrow the command.]`
    const acc = new BoundedOutput()

    // 13.3: when a sandbox is injected (the server's per-project Docker container), the command runs THERE
    // and the host is never touched. When absent (the extension), fall through to the host spawn below.
    if (ctx.sandbox) {
      try {
        const { output, exitCode } = await ctx.sandbox.exec(input.command, {
          cwd: ctx.cwd,
          signal: ctl.signal,
          onData: (chunk) => onProgress?.(chunk),
        })
        cleanup()
        acc.push(output)
        const body = acc.toString()
        if (timedOut) return { content: `${body}\n${timeoutMsg}`, isError: true }
        if (ctx.abortSignal.aborted) return { content: `${body}\n[aborted]`, isError: true }
        return { content: `${body || '(no output)'}${exitCode ? `\n[exit ${exitCode}]` : ''}`, isError: exitCode !== 0 }
      } catch (e) {
        cleanup()
        if (timedOut) return { content: `${acc.toString()}\n${timeoutMsg}`, isError: true }
        if (ctx.abortSignal.aborted) return { content: '[aborted]', isError: true }
        return { content: `Failed to run command in sandbox: ${(e as Error).message}`, isError: true }
      }
    }

    return new Promise<{ content: string; isError?: boolean }>((resolve) => {
      // `signal` makes Node kill the child when the controller aborts (timeout OR Stop) — no zombie shells.
      const child = spawn(input.command, { shell: true, cwd: ctx.cwd, signal: ctl.signal })
      const onData = (buf: Buffer) => {
        const s = buf.toString()
        acc.push(s) // bounded (head+tail); the raw chunk still streams live to the UI card below
        onProgress?.(s)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (e: NodeJS.ErrnoException) => {
        cleanup()
        if (timedOut) resolve({ content: `${acc.toString()}\n${timeoutMsg}`, isError: true })
        else if (ctx.abortSignal.aborted) resolve({ content: `${acc.toString()}\n[aborted]`, isError: true })
        else resolve({ content: `Failed to run command: ${e.message}`, isError: true })
      })
      child.on('close', (code) => {
        cleanup()
        if (timedOut) {
          resolve({ content: `${acc.toString()}\n${timeoutMsg}`, isError: true })
          return
        }
        const body = acc.toString()
        resolve({ content: `${body || '(no output)'}${code ? `\n[exit ${code}]` : ''}`, isError: code !== 0 })
      })
    })
  },
}
