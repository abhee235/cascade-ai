// tools/projectPath.ts — confine every file-tool path to the project root, and reconcile the sandbox.
//
// WHY (ADR-033): Cascade's file tools (Read/Write/Edit/Glob/Grep) run on the HOST via node:fs, but Bash runs
// in a Docker sandbox whose project dir is bind-mounted at /workspace. The model sees a SPLIT filesystem and
// may invent an absolute path (qwen36-agentic defaults to "/app" even when told otherwise); an unconfined host
// write then lands OUTSIDE the project — we watched it create C:\app\plan2.txt. This helper enforces ONE rule:
// every path resolves to a HOST path *inside* the project root (ctx.cwd). A container-style absolute prefix
// (/workspace, /app, the sandbox's own mount root) is treated as the project root; anything that still escapes
// is REJECTED, so Cascade never touches the host outside the project — in either deployment.
//
// Rather than confining via permission deny-rules alone, we HARD-JAIL to the project because we own a Docker
// root the model must reconcile.

import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A model-supplied path that points outside the project root. Returned to the model AS a tool error (never
 *  thrown past the tool) so it self-corrects to a relative path — the same self-correcting contract as our
 *  other tool errors (ADR-007). */
export class ProjectPathError extends Error {
  constructor(public readonly given: string) {
    super(
      `Path "${given}" is outside the project. Use a path relative to the project root (e.g. "src/App.tsx"), not an absolute path.`,
    )
    this.name = 'ProjectPathError'
  }
}

// Container-root aliases the model may use to MEAN "the project root". The sandbox's real mount root is passed
// in explicitly; these cover the conventions agentic models invent (we observed "/app") even when the prompt
// says otherwise. Each is treated as a synonym for the project root, then re-rooted at cwd.
const ROOT_ALIASES = ['/workspace', '/app']

/** True if `abs` is the project root itself or lives inside it (cross-platform: handles `..`, Windows drive
 *  letters, and case via node:path's `relative`). */
function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve a model-supplied path to a HOST absolute path CONFINED to the project root (`cwd`).
 *  - relative path                              → resolved against the project root
 *  - absolute path already inside the project   → accepted as-is (the model echoing the real cwd)
 *  - absolute under a container alias (/workspace, /app, sandboxRoot) → re-rooted at the project
 *  - anything still outside the project         → throws ProjectPathError (the host is never touched)
 *  `sandboxRoot` is the path the project is mounted at inside the sandbox (e.g. '/workspace'); pass
 *  `ctx.sandbox?.root`. */
export function resolveInProject(cwd: string, filePath: string, sandboxRoot?: string): string {
  const root = resolve(cwd)
  const raw = filePath.trim()

  // (A) An absolute path that already lands inside the project → accept it directly. Done first so a host cwd
  //     that happens to live under an alias (e.g. cwd === '/app/proj') is never double-rooted by step (B).
  if (isAbsolute(raw)) {
    const absHost = resolve(raw)
    if (isInside(root, absHost)) return absHost
  }

  // (B) Strip a container-root alias prefix so "/app/plan2.txt" or "/workspace/src/x" becomes project-relative.
  //     Match on forward slashes — the model writes POSIX paths even on Windows.
  let rel = raw.replace(/\\/g, '/')
  for (const alias of [sandboxRoot, ...ROOT_ALIASES].filter(Boolean) as string[]) {
    const a = alias.replace(/\\/g, '/')
    if (rel === a) {
      rel = '.'
      break
    }
    if (rel.startsWith(`${a}/`)) {
      rel = rel.slice(a.length + 1)
      break
    }
  }

  // (B2) A bare absolute like "/src/components/HomeView.tsx" — the model dropped the '/workspace' prefix
  //     but the FIRST segment is a real top-level entry of the project (src/, public/, index.html…).
  //     Measured (Simmer 128k run 4): 21 calls denied for exactly this shape — the model then "corrected"
  //     itself in circles and the 80-turn budget bled out on path friction. Re-root ONLY when the first
  //     segment exists at the project root, so a genuine host path (/etc/passwd, /Users/…) still falls
  //     through to (C) and is rejected; escapes like "/src/../../x" are also still caught by (C).
  if (rel.startsWith('/')) {
    const first = rel.slice(1).split('/')[0]
    if (first && existsSync(join(root, first))) rel = rel.slice(1)
  }

  // (C) Resolve against the project root and confine. An absolute leftover (a real host path or an unknown
  //     root) that isn't inside the project escapes → reject.
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
  if (!isInside(root, abs)) throw new ProjectPathError(filePath)
  return abs
}

/** A confined absolute path rendered as a clean project-relative string (forward slashes) for the UI card —
 *  so a file the model addressed as "/app/plan2.txt" or "/workspace/src/x" shows as "plan2.txt" / "src/x",
 *  reflecting where it actually lives in the project rather than the alias the model happened to use. */
export function displayPath(cwd: string, abs: string): string {
  return relative(resolve(cwd), abs).replace(/\\/g, '/') || '.'
}
