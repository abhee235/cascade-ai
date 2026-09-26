// sandbox/escalation.ts — the escalation vocabulary + choreography (ADR-070 step 2).
//
// When a confined call is denied, the model must be able to RECOVER in-context: the denial carries a
// marker it can recognize and a hint telling it the sanctioned retry — the same call again, once, with
// `sandbox_permissions` (the narrowest wider mode that suffices) and a one-sentence `justification`; a
// human approves; the grant applies to EXACTLY that call. This module is the one home for the ladder
// table, the argument-pairing validation, and the verbatim model-facing texts — shared by every
// enforcing tool family (Bash and the file tools) so the vocabulary can never drift between them.
// The approval round-trip itself lives in the SCHEDULER (which owns ask-and-park); tools never
// self-widen — a widened policy only ever arrives via the per-call ToolContext the scheduler builds.

import { z } from 'zod'
import { type SandboxMode, type SandboxPolicy, isConfined } from './policy'

/** What a call whose EFFECTIVE mode is the key may escalate TO — strictly wider only. Checked at
 *  execution, never baked into a schema: the schema's enum is the closed target vocabulary
 *  (ESCALATION_TARGETS), because schemas are advertised globally while the effective mode is per-call. */
export const WIDER_MODES: Record<SandboxMode, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/** Every mode a call could ever escalate TO (`read-only` is the floor; nothing escalates to it). */
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access'] as const

/** The escalation fields, spread into each enforcing tool's input schema (`...escalationFields`). Optional
 *  and inert when no confined policy is active — the scheduler bounces them with a clear error instead. */
export const escalationFields = {
  sandbox_permissions: z
    .enum(ESCALATION_TARGETS)
    .optional()
    .describe(
      'ONLY after a [sandbox: file access denied…] result: retry the identical call once with the NARROWEST wider file-policy mode that suffices. Requires justification; the user is asked to approve, and the grant applies to this one call. Set on any other call it is simply IGNORED (the call runs under the current policy) — never set it pre-emptively.',
    ),
  justification: z
    .string()
    .optional()
    .describe('REQUIRED with sandbox_permissions: one sentence explaining why this call needs the wider mode — shown verbatim to the user in the approval prompt.'),
}

/** One validated escalation ask, ready for the approval prompt. */
export interface EscalationAsk {
  mode: SandboxMode
  justification: string
}

/** The prefix every sandbox denial text starts with (see sandboxDenialMarker). The scheduler watches tool
 *  results for it to learn that a REAL denial happened this session — the only thing that grounds an
 *  escalation prompt. */
export const SANDBOX_DENIAL_PREFIX = '[sandbox: file access denied'

/** Session facts the judge needs beyond the policy: has any sandbox denial actually occurred yet? */
export interface EscalationContext {
  denialSeen?: boolean
}

/**
 * Parse + judge the escalation arguments off one tool input. Four outcomes:
 *   - `undefined` — no escalation fields (the common case costs nothing);
 *   - `{ error }`  — a MALFORMED pairing (verbatim texts, pinned by tests) — a model error, bounced;
 *   - `{ noop }`   — well-formed but not an escalation this session can honor: the mode is the current
 *                    one or narrower, no confined policy is active, or NO DENIAL HAS OCCURRED YET. The
 *                    call simply runs under the current policy; the note teaches the rule. This is a
 *                    no-op and never a failure, because failing the call is what manufactures
 *                    escalations: measured 2026-09-13 (gpt-5.6-luna, plan stage) — a pre-emptive ask
 *                    for the mode it already had was bounced as an error, the Write was DISCARDED, the
 *                    model concluded it needed more and asked for danger-full-access, and the run parked
 *                    on an approval prompt that a reflexive click would have turned into a full sandbox
 *                    bypass. "Only after a denial" is enforced HERE, mechanically — description text
 *                    alone measurably does not hold, on frontier models as on weak ones (ADR-049);
 *   - `{ ask }`    — strictly wider AND grounded in a real denial: the one case that reaches a human.
 * Pure: the scheduler owns the prompt and the session facts; this only judges.
 */
export function parseEscalation(
  input: unknown,
  policy: SandboxPolicy | undefined,
  session: EscalationContext = {},
): { error: string } | { noop: string } | { ask: EscalationAsk } | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  const mode = typeof i.sandbox_permissions === 'string' ? i.sandbox_permissions : undefined
  const justification = typeof i.justification === 'string' ? i.justification : undefined
  if (mode === undefined && justification === undefined) return undefined
  if (mode !== undefined && justification === undefined) {
    return { error: 'invalid escalation: sandbox_permissions requires a justification' }
  }
  if (justification !== undefined && mode === undefined) {
    return { error: 'invalid escalation: justification is only valid together with sandbox_permissions' }
  }
  if (justification !== undefined && justification.trim().length === 0) {
    return { error: 'invalid justification: expected a non-empty sentence' }
  }
  if (policy === undefined || !isConfined(policy.mode)) {
    return { noop: 'sandbox_permissions ignored — no confined sandbox policy is active for this session, so the call runs unrestricted anyway' }
  }
  if (!WIDER_MODES[policy.mode].includes(mode as SandboxMode)) {
    return { noop: `sandbox_permissions ignored — this call already runs under "${policy.mode}", which is not narrower than "${mode}"; the fields are only for retrying a call the sandbox DENIED` }
  }
  if (!session.denialSeen) {
    return { noop: `sandbox_permissions ignored — no sandbox denial has occurred in this session; the call runs under "${policy.mode}". Escalate only by retrying the exact call that got a ${SANDBOX_DENIAL_PREFIX}…] result` }
  }
  return { ask: { mode: mode as SandboxMode, justification: justification as string } }
}

/** Remove the escalation fields before execution — the scheduler CONSUMED them (they selected the
 *  per-call policy); the tool must see a clean input so no tool ever widens from its own arguments. */
export function stripEscalationFields<T>(input: T): T {
  const { sandbox_permissions: _p, justification: _j, ...rest } = (input ?? {}) as Record<string, unknown>
  return rest as T
}

/** Remove the escalation fields from ADVERTISED tool schemas (ADR-082 Part A, second half).
 *
 *  The judge already ignores an ungrounded ask — but an optional field the model can SEE is a field it
 *  fills. Measured 2026-09-15 (gpt-5.6-luna, full Northline build): 35 of 35 Write/Edit/Bash calls carried
 *  `sandbox_permissions`, every single one a no-op, and the "ignored" note came back 34 times without ever
 *  changing the behaviour. Explaining a rule in a field description does not hold — on frontier models as
 *  on weak ones (ADR-049). So the lever is not shown until a denial has actually occurred.
 *
 *  Cost accounting: the schema changes at most ONCE per session, only when a real denial happens (one
 *  KV-cache break at the moment the model is already re-reading a failure), and runs that never touch the
 *  fence — the overwhelming majority — never pay for the fields at all. */
export function withoutEscalationFields<T extends { parameters: Record<string, unknown> }>(schemas: T[]): T[] {
  return schemas.map((s) => {
    const props = s.parameters?.properties as Record<string, unknown> | undefined
    if (!props || (!('sandbox_permissions' in props) && !('justification' in props))) return s
    const { sandbox_permissions: _p, justification: _j, ...rest } = props
    return { ...s, parameters: { ...s.parameters, properties: rest } }
  })
}

/** The model-facing denial marker — ONE vocabulary across every enforcing family, so the model
 *  recognizes a policy denial identically whether the kernel refused a Bash file effect or the
 *  in-process file fence refused a mutation. Verbatim; pinned by tests. */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** The same-turn escalation hint that rides a denial — the nudge lives at the decision point so the
 *  sanctioned retry does not depend on the model recalling the tool description (the weak-model
 *  lesson behind ADR-070 step 2). `subject` is the family's noun: 'command' (Bash), 'operation' (fs). */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/** A complete denial text: the marker, one plain sentence, and — only when a wider mode EXISTS — the
 *  escalation hint. A `danger-full-access` policy never denies, and a mode with no wider rung must not
 *  advertise a lever that cannot work. */
export function denialText(mode: SandboxMode, subject: string, sentence: string): string {
  const hint = WIDER_MODES[mode].length > 0 ? `\n${escalationHintMarker(subject)}` : ''
  return `${sandboxDenialMarker(mode)} ${sentence}${hint}`
}

/** The in-process READ-ONLY fence for file-mutating tools (Edit/Write/MultiEdit): under a `read-only`
 *  policy a mutation is denied HERE, before any filesystem work — which makes read-only mode real today,
 *  with or without a backend that enforces it. Returns the denial text, or undefined when not fenced. */
export function fileWriteFence(policy: SandboxPolicy | undefined): string | undefined {
  if (policy?.mode !== 'read-only') return undefined
  return denialText('read-only', 'operation', 'This operation modifies files, and the session file policy is read-only.')
}
