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
})

// ADR-037: a weak model leans on the tool description to know WHEN and HOW to use Bash. It covers the
// git-safety protocol, tool-preference, quoting, interactivity, and parallelism, condensed
// for a local model and Cascade's sandbox. Descriptions are advertised EVERY request, so like the system prompt
// they are TIER-SIZED (the description is a function of the window tier — toolRegistry.descriptionOf).
const BASH_DESCRIPTION_FULL = `Run a shell command in the project and return its combined stdout/stderr. Use it for real shell work — building, running tests, installing dependencies, git, and running scripts.

Prefer the dedicated tools over Bash so the user can review your work:
- Read a file with Read (not cat/head/tail); change one with Edit (not sed/awk); create one with Write (not echo > or heredoc).
- Find files by name with Glob (not find/ls); search file contents with Grep (not grep/rg).
Reserve Bash for commands that genuinely need a shell.

Execution notes:
- The working directory persists between calls, but shell state (env vars, cd) does NOT — prefer absolute or project-relative paths over \`cd\`. Quote paths that contain spaces.
- Do NOT run interactive commands (they hang): nothing that waits for input, such as \`git add -i\` or \`git rebase -i\`.
- Multiple commands: if independent, send several Bash calls in ONE message (they run in parallel); if they depend on each other, chain them with \`&&\` in a single call. Don't separate commands with newlines.
- Output is truncated if very long (the tail is kept). A non-zero exit is returned as an error — read it and fix the cause.

Git safety (only when the user asks you to commit):
- Only commit when explicitly asked. Create a NEW commit — never \`--amend\` unless asked (when a pre-commit hook fails there is no new commit, so --amend would change the previous one).
- Don't use git commands that throw work away (\`push --force\`, \`reset --hard\`, \`checkout .\`, \`clean -f\`, deleting a branch) unless the user asks for them. Never skip hooks (\`--no-verify\`).
- Stage specific files by name rather than \`git add -A\`, to avoid committing secrets (.env) or junk.`

// lean (32k/64k): every load-bearing rule, one line each — no elaboration.
const BASH_DESCRIPTION_LEAN = `Run a shell command (build, test, install, git, scripts); returns stdout+stderr. Prefer the dedicated tools: Read (not cat), Edit (not sed), Write (not echo>), Glob (not find), Grep (not grep/rg). No interactive commands (they hang). Independent commands: separate parallel calls; dependent: chain with &&. Shell state doesn't persist between calls — avoid cd. Git: only commit when asked; new commits (no --amend); no destructive commands (push --force, reset --hard) or --no-verify unless explicitly asked; stage files by name.`

// minimal (<24k): the two rules that prevent real damage.
const BASH_DESCRIPTION_MINIMAL = `Run a shell command (build/test/git); returns output. Prefer Read/Edit/Write/Glob/Grep for file work. No interactive commands. Git: only commit when asked; never destructive commands (--force, reset --hard, --no-verify) unless explicitly asked.`

const bashDescription = (tier: 'minimal' | 'lean' | 'full'): string =>
  tier === 'full' ? BASH_DESCRIPTION_FULL : tier === 'lean' ? BASH_DESCRIPTION_LEAN : BASH_DESCRIPTION_MINIMAL

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

const MAX_OUTPUT = 30_000 // keep the tool_result bounded; tail is the most useful part

export const BashTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Bash',
  description: bashDescription, // tier-sized (ADR-037): rich on 128k+, essentials on small windows
  inputSchema,
  activitySummary: (input) => `Running: ${input.command.length > 60 ? `${input.command.slice(0, 60)}…` : input.command}`,
  isReadOnly: (input) => isReadOnlyCommand(input.command),
  isConcurrencySafe: (input) => isReadOnlyCommand(input.command), // safe commands can parallelize; mutating ones run solo

  async call(input, ctx, onProgress) {
    // 13.3: when a sandbox is injected (the server's per-project Docker container), the command runs THERE
    // and the host is never touched. When absent (the extension), fall through to the host spawn below.
    if (ctx.sandbox) {
      try {
        const { output, exitCode } = await ctx.sandbox.exec(input.command, {
          cwd: ctx.cwd,
          signal: ctx.abortSignal,
          onData: (chunk) => onProgress?.(chunk),
        })
        const body = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…[truncated]` : output
        return { content: `${body || '(no output)'}${exitCode ? `\n[exit ${exitCode}]` : ''}`, isError: exitCode !== 0 }
      } catch (e) {
        return { content: `Failed to run command in sandbox: ${(e as Error).message}`, isError: true }
      }
    }

    return new Promise<{ content: string; isError?: boolean }>((resolve) => {
      // `signal` makes Node kill the child when the session aborts (Stop button) — no zombie shells.
      const child = spawn(input.command, { shell: true, cwd: ctx.cwd, signal: ctx.abortSignal })
      let out = ''
      const onData = (buf: Buffer) => {
        const s = buf.toString()
        if (out.length < MAX_OUTPUT) out += s
        onProgress?.(s) // stream the chunk live into the UI card (Phase 8)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (ctx.abortSignal.aborted) resolve({ content: `${out}\n[aborted]`, isError: true })
        else resolve({ content: `Failed to run command: ${e.message}`, isError: true })
      })
      child.on('close', (code) => {
        const body = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated]` : out
        resolve({ content: `${body || '(no output)'}${code ? `\n[exit ${code}]` : ''}`, isError: code !== 0 })
      })
    })
  },
}
