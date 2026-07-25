// agent/reEditGate.ts — harness-detected RE-EDIT breaker (ADR-072). Sibling of the ADR-058 read-loop gate.
//
// Corpus (22 product builds, 2026-07-24): a single file was edited ≥5× in 55% of builds; the model thrashes a
// file whose problem-source lives elsewhere (Velocarta: the CTA colour was re-diagnosed THREE times and fixed
// at the call site while it actually came from the theme token). "I keep editing this and it isn't resolving"
// is meta-cognition weak models don't do — but the LOOP can count and point them at Grep/Lsp to trace the
// real source. Same detect→remind idiom as read-loop/verify/delegate; a pure fold helper + one nudge.

import type { ContentBlock } from '../protocol'
import type { ToolUse } from '../tools/runTool'

/** Edits to the SAME file before the nudge fires. Higher than the read-loop gate (3): edits are far more often
 *  legitimately iterative (building a page section by section), so only SUSTAINED churn on one file trips it. */
export const REEDIT_THRESHOLD = 6

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

/**
 * Fold one executed tool batch into per-file edit counters. A SUCCESSFUL Edit/Write of a file increments its
 * count; returns the files whose count crossed the threshold in THIS batch (each fires exactly once — the count
 * only equals the threshold at the crossing). No reset: sustained churn on one file across a build is exactly
 * the signal, and the nudge is advisory, so one firing per file is enough.
 */
export function foldReEdit(counts: Map<string, number>, toolUses: ToolUse[], results: ContentBlock[]): string[] {
  const okById = new Map(results.map((r) => [r.type === 'tool_result' ? r.tool_use_id : '', r.type === 'tool_result' && !r.isError]))
  const crossed: string[] = []
  for (const tu of toolUses) {
    if (!okById.get(tu.id)) continue
    if (!EDIT_TOOLS.has(tu.name)) continue
    const input = (tu.input ?? {}) as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path.trim() : ''
    if (!path) continue
    const n = (counts.get(path) ?? 0) + 1
    counts.set(path, n)
    if (n === REEDIT_THRESHOLD) crossed.push(path)
  }
  return crossed
}

/** The reminder — appended to the trailing tool_results message (ADR-034 channel: reaches the model, never the
 *  UI). Advisory (harmless if the edits were genuine separate improvements), and re-anchored to action so a
 *  weak model acts on it rather than replying (item-4 lesson). */
export function buildReEditNudge(path: string): string {
  return (
    `<system-reminder>You have now edited ${path} ${REEDIT_THRESHOLD} times. If the SAME problem keeps returning ` +
    'after each edit, its source is elsewhere: a colour/style comes from a theme token, a shape from a shared ' +
    'type — not the file that uses it. Before editing this file again, use **Grep** to find where the offending ' +
    'value or symbol is DEFINED, or **Lsp** (definition/references) to jump to it, and fix it there. If these ' +
    'edits are genuine separate improvements, ignore this. This is a background note, NOT a new request: do not reply — act.</system-reminder>'
  )
}
