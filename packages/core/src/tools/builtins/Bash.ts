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
  description: 'Run a shell command and return its combined stdout/stderr. Use for builds, tests, git, listing files, etc.',
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
