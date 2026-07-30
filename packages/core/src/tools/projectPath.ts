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
/** How a frontend confines file paths (ADR-033 + the 2026-07-28 parity change):
 *  - 'jail'   (DEFAULT): a path outside the project is REFUSED by the tool. Required by the sandboxed web
 *    builder — its project dir is model-writable and it runs `bypass`, so the gate would never object.
 *  - 'prompt' (the VS Code extension): outside paths RESOLVE, and the permission gate
 *    asks the user to approve them. `roots` widens the no-prompt area (cwd + additionalDirectories). */
export type PathAccess = 'jail' | 'prompt'

export interface PathScope {
  /** Extra directories treated as inside (no prompt). The project root is always implicitly included. */
  roots?: string[]
  policy?: PathAccess
}

/** True when `abs` is inside the project root or any additional allowed root. */
export function isAllowedPath(cwd: string, abs: string, roots?: string[]): boolean {
  if (isInside(resolve(cwd), abs)) return true
  return (roots ?? []).some((r) => isInside(resolve(r), abs))
}

export function resolveInProject(cwd: string, filePath: string, sandboxRoot?: string, scope?: PathScope): string {
  const root = resolve(cwd)
  const raw = filePath.trim()

  // (A) An absolute path that already lands inside the project (or an additional allowed root) → accept it
  //     directly. Done first so a host cwd that happens to live under an alias (e.g. cwd === '/app/proj')
  //     is never double-rooted by step (B).
  if (isAbsolute(raw)) {
    const absHost = resolve(raw)
    if (isAllowedPath(root, absHost, scope?.roots)) return absHost
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
  if (isAllowedPath(root, abs, scope?.roots)) return abs
  // Outside every allowed root. 'jail' refuses here (the tool never touches the host); 'prompt' hands the
  // path back and the PERMISSION GATE becomes the enforcement point.
  if (scope?.policy === 'prompt') return abs
  throw new ProjectPathError(filePath)
}

/** Reject a glob PATTERN that can escape the project. `resolveInProject` jails the `path` OPTION, but the
 *  pattern itself goes straight to fast-glob — measured (2026-07-28 jail audit): `Glob {pattern:"../*.txt"}`
 *  listed files outside the root and `Grep {glob:"../*.txt"}` printed their CONTENTS. Absolute patterns are
 *  refused for the same reason (fast-glob honors them regardless of `cwd`). */
export function assertPatternInProject(pattern: string): void {
  const norm = pattern.replace(/\\/g, '/')
  const escapes = norm === '..' || norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')
  if (escapes || isAbsolute(pattern) || norm.startsWith('/')) throw new ProjectPathError(pattern)
}

/** True when `abs` lives inside the project root — exported so match lists can be filtered as defense in
 *  depth (symlinks, future glob syntaxes) even after the pattern check passes. */
export function isInsideProject(root: string, abs: string): boolean {
  return isInside(resolve(root), resolve(abs))
}

/** A confined absolute path rendered as a clean project-relative string (forward slashes) for the UI card —
 *  so a file the model addressed as "/app/plan2.txt" or "/workspace/src/x" shows as "plan2.txt" / "src/x",
 *  reflecting where it actually lives in the project rather than the alias the model happened to use. */
export function displayPath(cwd: string, abs: string): string {
  return relative(resolve(cwd), abs).replace(/\\/g, '/') || '.'
}
