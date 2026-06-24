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

import type { Tool } from '../tools/Tool'

/** Who sets this: the FRONTEND/deployment, not the model. The extension runs 'default'; a sandboxed
 *  sandboxed web frontend would run 'bypass'. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionState {
  mode: PermissionMode
  /** Tool names the user has allow-always'd this session (or pre-seeded from config). */
  allow: Set<string>
  /** Tool names hard-denied. */
  deny: Set<string>
}

/** Decide what to do with one tool call. Pure: no I/O, no awaiting. */
export function checkPermission(tool: Tool, input: unknown, state: PermissionState): PermissionDecision {
  const readOnly = tool.isReadOnly?.(input as never) ?? false

  // 1. MODE short-circuits (the frontend's policy wins outright).
  if (state.mode === 'bypass') return 'allow' // sandboxed → no prompts at all
  if (state.mode === 'plan') return readOnly ? 'allow' : 'deny' // explore only; nothing writes

  // 2. Explicit RULES (a remembered "always"/"never" for this tool).
  if (state.deny.has(tool.name)) return 'deny'
  if (state.allow.has(tool.name)) return 'allow'

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
