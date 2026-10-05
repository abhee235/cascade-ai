// tools/builtins/Write.ts — create or overwrite a file. NOT read-only (matters for Phase 6 concurrency).

import { z } from 'zod'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Tool } from '../Tool'
import { normalizeText } from '../fileState'
import { readFreshnessError } from '../editCore'
import { lineDiff } from '../../utils/diff'
import { assertWritable, displayPath, FrozenPathError, ProjectPathError, resolveInProject } from '../projectPath'
import { escalationFields, fileWriteFence } from '../../sandbox/escalation'

const inputSchema = z.object({
  file_path: z.string().describe('Path to the file to write, relative to the workspace or absolute.'),
  content: z.string().describe('The full content to write. Overwrites the file if it exists.'),
  // ADR-070 step 2: the escalation pair — validated + consumed by the SCHEDULER (never read here).
  ...escalationFields,
})

/** Dependency names declared in `dependencies`/`devDependencies` of OLD but absent from BOTH sections of
 *  NEW (a dep moved between sections is kept, not removed). Unparseable JSON on either side ⇒ no opinion —
 *  a malformed manifest is the build's error to report, not this guard's. */
function removedDependencies(oldJson: string, newJson: string): string[] {
  try {
    const declared = (j: unknown): Set<string> => {
      const p = j as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      return new Set([...Object.keys(p?.dependencies ?? {}), ...Object.keys(p?.devDependencies ?? {})])
    }
    const oldDeps = declared(JSON.parse(oldJson))
    const newDeps = declared(JSON.parse(newJson))
    return [...oldDeps].filter((d) => !newDeps.has(d))
  } catch {
    return []
  }
}

export const WriteTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'Write',
  // ADR-037: deliberately NOT tier-sized — "overwrites the ENTIRE file / Read it first" prevents destroying
  // work the model hasn't seen; short enough to afford at every tier.
  description: `Create a NEW file, or COMPLETELY OVERWRITE an existing one, with the given UTF-8 content. Parent directories are created automatically.
Prefer Edit for changing part of a file — Write replaces the ENTIRE file, so it's easy to destroy content you didn't mean to. If the file already exists, Read it first so you don't overwrite work you haven't seen. Use Write for brand-new files or a deliberate full rewrite.`,
  inputSchema,
  activitySummary: (input) => `Writing ${input.file_path}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => false, // writes can race — never parallelize

  async call(input, ctx) {
    // ADR-070 step 2: the read-only fence — before any path/filesystem work. An approved escalation
    // arrives as a widened ctx.sandboxPolicy (the scheduler's one-call grant) and passes.
    const fence = fileWriteFence(ctx.sandboxPolicy)
    if (fence) return { content: fence, isError: true }
    let path: string
    try {
      path = resolveInProject(ctx.cwd, input.file_path, ctx.sandbox?.root, ctx.pathScope) // ADR-033: jail to the project root
      assertWritable(ctx.cwd, path, ctx.pathScope) // frozen prefixes (shared blocks/kit) reject writes
    } catch (e) {
      if (e instanceof ProjectPathError || e instanceof FrozenPathError) return { content: e.message, isError: true }
      throw e
    }
    try {
      // CASE-COLLISION guard (measured, dokar/qwen3.5-9B 2026-08-09): the model wrote `tasks/taskList.tsx`
      // twice and `tasks/TaskList.tsx` once — on a case-insensitive filesystem (Windows/macOS default)
      // those are the SAME file, so the two "components" silently overwrote each other while imports of
      // both names kept the build broken across five runs. And even on a case-sensitive filesystem,
      // sibling files differing only by case break the project the moment it's opened on Windows/macOS —
      // so the guard is unconditional: name the existing file and make the model choose deliberately.
      const name = basename(path)
      const siblings = await readdir(dirname(path)).catch(() => [] as string[])
      const collision = siblings.find((s) => s !== name && s.toLowerCase() === name.toLowerCase())
      if (collision) {
        return {
          content:
            `A file named "${collision}" already exists in that directory — "${name}" differs from it only by CASE, ` +
            `and on Windows/macOS they are the SAME file (this write would overwrite "${collision}"). ` +
            `To change the existing file, call Write/Edit with its exact name "${collision}". To create a genuinely new file, pick a clearly different name.`,
          isError: true,
        }
      }
      const before = await readFile(path, 'utf8').catch(() => undefined) // undefined ⇒ new file
      // FRESHNESS gate for OVERWRITES (batch-3): a Write on an EXISTING file the model never Read silently
      // destroys content it has never seen — the scaffold's App.tsx wiring is the standing risk, and the
      // case-collision + package.json guards below were special cases of exactly this hole. Same contract
      // and same escape hatches as Edit (readFreshnessError): a brand-new file needs no read, the model's
      // own previous Write counts as knowledge (ADR-032), and headless smokes with no cache are exempt.
      if (before !== undefined) {
        const fresh = await readFreshnessError(ctx.readFileState, path, input.file_path, normalizeText(before))
        if (fresh) {
          return { content: fresh.replace('before editing it.', 'before overwriting it with Write — or change just part of it with Edit.'), isError: true }
        }
      }
      // SCAFFOLD-CONTRACT guard (measured, hotelnow 2026-08-10): the model rewrote package.json from its
      // training prior — Tailwind v3, dropping @tailwindcss/vite — while the preview force-restores the
      // template's vite.config.ts (ensureVisualEditConfig), which imports that very package. Result:
      // "Cannot find package '@tailwindcss/vite'" on every preview start. Not a weak-model rung: ANY
      // wholesale rewrite that drops declared dependencies breaks configs pinned by the product, so a
      // Write that REMOVES existing deps is rejected with the removed names. Deliberate removal stays
      // possible via Edit, which targets the specific line instead of replacing the manifest.
      if (name === 'package.json' && before !== undefined) {
        const removed = removedDependencies(before, input.content)
        if (removed.length) {
          return {
            content:
              `This Write REMOVES ${removed.length} declared dependenc${removed.length === 1 ? 'y' : 'ies'} from package.json: ${removed.join(', ')}. ` +
              'The project scaffold (vite config, plugins, styling) depends on the existing entries, and replacing the whole manifest breaks the build/preview even when your version looks self-consistent. ' +
              'Keep all existing dependencies: ADD what you need with Edit (or a Write that preserves the current entries). If removing a dependency is genuinely intended, remove exactly that line with Edit.',
            isError: true,
          }
        }
      }
      await mkdir(dirname(path), { recursive: true }) // create parent dirs
      await writeFile(path, input.content, 'utf8')
      // ADR-032: a successful Write IS the freshest possible knowledge of the file — record it, so a
      // follow-up Edit doesn't get rejected with "modified since you read it" (measured, Simmer run 5:
      // two Write→Edit pairs each paid a rejection + a re-read turn for a file the model itself just wrote).
      if (ctx.readFileState) {
        const st = await stat(path).catch(() => undefined)
        ctx.readFileState.set(path, { content: normalizeText(input.content), timestamp: st?.mtimeMs ?? Date.now() })
      }
      return {
        content: `Wrote ${input.content.length} chars to ${input.file_path}`,
        display: {
          kind: 'fileEdit',
          path: displayPath(ctx.cwd, path), // ADR-033: show where it actually lives in the project, not the model's alias
          op: before === undefined ? 'create' : 'overwrite',
          diff: lineDiff(before ?? '', input.content),
        },
      }
    } catch (e) {
      // Return the error so the model can fix the path/retry (self-correction) — don't throw.
      return {
        content: `Error writing ${input.file_path}: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }
  },
}
