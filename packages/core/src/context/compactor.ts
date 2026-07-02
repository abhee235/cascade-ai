// context/compactor.ts — keep the conversation within the model's window (ADR-012 / ADR-039). The orchestrator:
// runs an escalating stack of pure, no-LLM layers (collapse → mask → microcompact → snip; compactionLayers.ts)
// cheapest-first, stopping as soon as history is back under the plan's `auto` threshold; only if they don't free
// enough does it fall back to the LLM summary (the older half → one message, recent half kept verbatim).
// Returns NEW messages; the raw transcript + JSONL trace are untouched (the session swaps its history array).


import type { Message } from '../protocol'
import type { ModelProvider } from '../llm/provider'
import type { CompactionLayer, CompactionPlan } from './compactionPlan'
import {
  collapseSuperseded,
  maskObservations,
  microcompactToolResults,
  snipLargeToolInputs,
  type CompactionKind,
} from './compactionLayers'

// Sizing/thresholds live in the CompactionPlan (ADR-039); the pure no-LLM layers live in compactionLayers.ts.
// Re-exported here so existing importers (session.ts, tests, UIs) keep a single import site.
export {
  planCompaction,
  resolveCompactionPlan,
  ALL_COMPACTION_LAYERS,
  type CompactionPlan,
  type CompactionLayer,
} from './compactionPlan'
export {
  collapseSuperseded,
  maskObservations,
  microcompactToolResults,
  snipLargeToolInputs,
  compactionKindLabel,
  isClearedContent,
  COMPACTABLE_TOOLS,
  type CompactionKind,
} from './compactionLayers'

/** Rough token estimate (chars/4) over serialized content — no tokenizer dependency. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else
      for (const b of m.content) {
        if (b.type === 'text') chars += b.text.length
        else if (b.type === 'thinking') chars += b.thinking.length
        else if (b.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length
        else if (b.type === 'tool_result') chars += b.content.length
      }
  }
  return Math.ceil(chars / 4)
}

/** Index splitting [older | recent]: keep the most-recent messages that fit within keepRecentTokens verbatim;
 *  everything before is "older". Returns the boundary index (older = [0..idx), recent = [idx..]). */
export function olderBoundary(messages: Message[], keepRecentTokens: number): number {
  let acc = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]])
    if (acc > keepRecentTokens) return i + 1 // including message i would overflow the recent window
  }
  return 0 // it all fits in the recent window → nothing older
}

/** Turn-align the SUMMARIZE split so the surviving history is a VALID message sequence for any provider.
 *  Summarize drops the older region and prepends one `user` summary; the recent region must therefore START on
 *  an assistant message. Otherwise recent[0] is a `user(tool_result)` whose `assistant(tool_use)` was just
 *  summarized away → an ORPHANED tool result (a hard 400 on strict hosted APIs such as OpenAI; silently accepted by Ollama), and
 *  `user(summary)` + `user(...)` would also be two adjacent user turns (also rejected by strict providers).
 *  Walk the boundary back to the nearest assistant. If the older region has no assistant at all (degenerate —
 *  e.g. an all-text history, which by definition has no tool pairs to orphan), keep the raw split. — ADR-039. */
export function turnAlignedBoundary(messages: Message[], boundary: number): number {
  let b = Math.min(boundary, messages.length)
  while (b > 0 && messages[b]?.role !== 'assistant') b--
  return b > 0 ? b : boundary
}

// The structured summary prompt: seven headings built around what the agent needs to resume (where the work
// stands, which files matter, what was decided) rather than a chronological retelling. TEXT ONLY.
const COMPACT_SYSTEM = `You are summarizing the EARLIER part of a coding conversation so it can be replaced by your summary while the recent messages are kept verbatim. Be thorough on the technical detail needed to continue the work without losing context. Reply in plain text only; make no tool calls.

Write the summary under these headings:
- Goal — what the user wants, in their own words where it matters.
- State of the work — what is done, what is half-done, and exactly where it stopped.
- Files — every file created or changed: its path, what it is for, and any snippet the work still depends on.
- Decisions and constraints — what was decided and why, and every rule the user set.
- Problems and fixes — errors met, what fixed them, and any correction the user made.
- User messages — each one in order, briefly.
- Next — the next action, only if the latest request calls for it; quote the last line of work so it resumes in place.`

function serialize(messages: Message[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) =>
                b.type === 'text'
                  ? b.text
                  : b.type === 'thinking'
                    ? `(thinking) ${b.thinking}`
                    : b.type === 'tool_use'
                      ? `(tool ${b.name} ${JSON.stringify(b.input ?? {})})`
                      : b.type === 'tool_result'
                        ? `(result) ${b.content}`
                        : '',
              )
              .join('\n')
      return `${m.role.toUpperCase()}: ${text}`
    })
    .join('\n\n')
}

async function summarize(older: Message[], provider: ModelProvider, model: string, signal?: AbortSignal): Promise<string> {
  const res = await provider.complete({ messages: [{ role: 'user', content: serialize(older) }], model, system: COMPACT_SYSTEM }, signal)
  return res.text.trim()
}

export interface CompactDeps {
  provider: ModelProvider
  model: string
  plan: CompactionPlan // ADR-039: thresholds + gated layers, derived from the model profile (ADR-038)
  signal?: AbortSignal
  /** Coupled curation (ADR-015): harvest durable facts from the OLDER messages before they're compressed. */
  onDiscard?: (older: Message[]) => Promise<void>
}

// The pure, no-LLM layers in escalation order, each mapped to the kind it reports. `summarize` is handled
// separately (it's async + needs the provider). Adding a layer later = one entry here + its transform.
const CHEAP_LAYERS: { layer: CompactionLayer; kind: CompactionKind; apply: (m: Message[], older: number, plan: CompactionPlan) => Message[] }[] = [
  { layer: 'collapse', kind: 'collapsed', apply: (m, older) => collapseSuperseded(m, older) },
  { layer: 'mask', kind: 'masked', apply: (m, older, plan) => maskObservations(m, older, plan.toolResultMaxChars) },
  { layer: 'microcompact', kind: 'microcompacted', apply: (m, older) => microcompactToolResults(m, older) },
  { layer: 'snip', kind: 'snipped', apply: (m, older, plan) => snipLargeToolInputs(m, older, plan.toolResultMaxChars) },
]

/**
 * Compact `messages` when they cross the plan's `auto` threshold (ADR-039). Runs the plan's enabled layers in
 * escalation order — collapse → mask → microcompact → snip (pure, no LLM) — stopping the moment history is back
 * under `auto`; only if those don't free enough does it fall back to `summarize` (LLM side-query on the older
 * half). `force` (reactive overflow) bypasses the threshold gate and always compresses as hard as it can.
 * Returns the (possibly) new history and the kind of the most aggressive layer that ran.
 */
export async function compactIfNeeded(
  messages: Message[],
  deps: CompactDeps,
  opts?: { force?: boolean },
): Promise<{ messages: Message[]; kind: CompactionKind }> {
  const { plan } = deps
  const force = opts?.force ?? false
  if (!force && estimateTokens(messages) < plan.auto) return { messages, kind: 'none' }

  const boundary = olderBoundary(messages, plan.keepRecentTokens)
  if (boundary === 0) return { messages, kind: 'none' } // all fits in the recent window — nothing older to compact

  // ── Cheap layers: escalate, stopping as soon as we're back under threshold. ──
  // These are length-preserving (they clear content / stub inputs, never drop messages), so `boundary` stays
  // valid across all of them. `kind` tracks the most aggressive layer that actually reduced tokens.
  let working = messages
  let kind: CompactionKind = 'none'
  for (const step of CHEAP_LAYERS) {
    if (!plan.layers.has(step.layer)) continue
    const next = step.apply(working, boundary, plan)
    if (estimateTokens(next) < estimateTokens(working)) {
      working = next
      kind = step.kind
    }
    if (!force && estimateTokens(working) < plan.auto) return { messages: working, kind }
  }

  // ── Heavy layer: LLM summary of the older half, recent kept verbatim. ──
  if (plan.layers.has('summarize')) {
    // Recompute the boundary: the cheap layers changed token counts, shifting where "recent" starts. Then
    // turn-align it so `recent` starts on an assistant — summarize replaces `older` with one user message, so a
    // recent region beginning with a tool_result (or a user turn) would orphan a tool pair / stack two user
    // messages, which strict providers reject (see turnAlignedBoundary).
    const summarizeBoundary = turnAlignedBoundary(working, olderBoundary(working, plan.keepRecentTokens))
    if (summarizeBoundary > 0) {
      const older = working.slice(0, summarizeBoundary)
      const recent = working.slice(summarizeBoundary)
      if (deps.onDiscard) await deps.onDiscard(older)
      const summary = await summarize(older, deps.provider, deps.model, deps.signal)
      const summaryMsg: Message = { role: 'user', content: `[Earlier conversation compacted to save context]\n\n${summary}` }
      return { messages: [summaryMsg, ...recent], kind: 'summarized' }
    }
  }

  return { messages: working, kind }
}
