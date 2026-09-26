// sandbox/policy.ts — the sandbox POLICY vocabulary (ADR-070 Part A, step 1).
//
// ADR-024 gave core the *shape* of "run a command somewhere" (Sandbox.exec). This module gives core the
// shape of "what file effects that execution is ALLOWED" — three modes on a strict ladder, resolved
// per call, with one shared derivation of what each mode MEANS. Core still knows no mechanism: backends
// (Docker today; WSL/Seatbelt/bwrap/write-fence per ADR-070) enforce the policy in their own dialect,
// and the in-process file tools will read the SAME derivation, so "Edit can write /tmp but Bash can't"
// asymmetries cannot arise between them.

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** The strict ladder, narrowest first. `read-only` is the floor (plan mode / fallback); `workspace-write`
 *  is the builder's working default; `danger-full-access` is an explicit opt-in, never a silent default. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** The fully resolved per-call policy every enforcing layer consumes. */
export interface SandboxPolicy {
  mode: SandboxMode
  /** The workspace boundary, canonicalized (see canonicalPath). For a container-style backend this is the
   *  IN-SANDBOX mount (e.g. '/workspace') — the path the model and the enforcement layer both see. */
  workspaceRoot: string
}

/** Resolve filesystem identity BEFORE comparing paths. The NATIVE realpath is deliberate: it follows the
 *  filesystem's component-by-component lookup (symlinks, case, 8.3 aliases) the way chdir/spawn and the
 *  enforcement layers do — Node's JS implementation lexically collapses `..` before resolving a preceding
 *  symlink on some platforms, which would derive a DIFFERENT identity than the kernel enforces. A missing
 *  path returns its spelling unchanged: it matches nothing until it exists (the conservative outcome —
 *  inventing a fallback would grant a path the caller never named). */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** The resolution ladder for one call: an explicitly approved mode (a granted escalation — step 2) outranks
 *  the session's standing override (a /permission-style switch), which outranks the deployment default.
 *  Pure so the ladder is unit-testable; callers own where each rung's value comes from. */
export function resolveSandboxMode(
  explicit: SandboxMode | undefined,
  sessionOverride: SandboxMode | undefined,
  defaultMode: SandboxMode,
): SandboxMode {
  return explicit ?? sessionOverride ?? defaultMode
}

/** Does this mode confine at all? `danger-full-access` means "no sandbox restriction" — backends skip
 *  wrapping and the policy line says so honestly. */
export function isConfined(mode: SandboxMode): boolean {
  return mode !== 'danger-full-access'
}

/** The roots one confined execution may WRITE under — the mode's MEANING as a canonical, deduplicated
 *  allow-list. `read-only` allows nothing. `workspace-write` allows the workspace root plus the temp
 *  areas ('/tmp' for POSIX/container backends, the platform tmpdir for host backends — both included
 *  unconditionally because the backend, not the host, decides which one exists; an extra entry that
 *  matches no real path grants nothing). Omitting temp would deny what the mode promises: mkstemp-family
 *  tools, npm, and build caches all write there. `danger-full-access` is not an allow-list question —
 *  callers check isConfined() first; here it returns the workspace root only as a harmless identity. */
export function writableRoots(policy: SandboxPolicy): string[] {
  if (policy.mode !== 'workspace-write') return policy.mode === 'danger-full-access' ? [canonicalPath(policy.workspaceRoot)] : []
  return [...new Set([canonicalPath(policy.workspaceRoot), '/tmp', canonicalPath(tmpdir())])]
}

/** The one-line policy section for the system prompt (ADR-070: the model knows the standing policy without
 *  tool-description bloat). Rendered ONLY when a policy is supplied, so frontends that don't opt in (the
 *  VS Code extension) keep byte-identical prompts. Kept to one stable line per mode — it rides every
 *  request, and a changing line would break KV-cache prefixes. */
export function renderSandboxPolicy(policy: SandboxPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return `- File policy: read-only — sandboxed commands and file tools cannot modify files this session. Do not refuse a required change from this line alone: attempt the tool normally and follow the denial guidance it returns.`
    case 'workspace-write':
      return `- File policy: workspace-write — you may create and modify files under the working directory (and temp areas). Writes elsewhere are denied by the sandbox.`
    case 'danger-full-access':
      return `- File policy: full access — file modifications are not restricted by a sandbox this session.`
  }
}
