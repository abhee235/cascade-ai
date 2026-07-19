// context/compactor.ts — keep the conversation within the model's window (ADR-012 / ADR-039). The orchestrator:
// runs an escalating stack of pure, no-LLM layers (collapse → mask → microcompact → snip; compactionLayers.ts)
// cheapest-first, stopping as soon as history is back under the plan's `auto` threshold; only if they don't free
// enough does it fall back to the LLM summary (the older half → one message, recent half kept verbatim).
// Returns NEW messages; the raw transcript + JSONL trace are untouched (the session swaps its history array).


import type { Message } from '../protocol'
import type { ModelProvider } from '../llm/provider'
import { completeWithRecovery } from '../llm/resilience'
import type { CompactionLayer, CompactionPlan } from './compactionPlan'
import {
  collapseSuperseded,
  maskObservations,
  microcompactToolResults,
  shieldedResultIds,
  snipLargeToolInputs,
  unconsumedReadIds,
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
  unconsumedReadIds,
  compactionKindLabel,
  isClearedContent,
  COMPACTABLE_TOOLS,
  type CompactionKind,
} from './compactionLayers'

/** ADR-052 companion — MEASURED wire overhead. The backend reports the REAL prompt size after every call
 *  (`prompt_eval_count`); the difference vs our chars/4 message estimate IS everything the wire adds
 *  (system + tool schemas + chat template + estimate error). Measured incident: static estimate said
 *  6.4k, the wire said 8,191/8,192 — the model got ONE output token. EMA smooths run-to-run jitter;
 *  floor 0 (an overcounting estimate must not produce negative overhead). */
export function measureWireOverhead(prev: number | undefined, realInputTokens: number, sentEstimate: number): number {
  const measured = Math.max(0, realInputTokens - sentEstimate)
  return prev === undefined ? measured : Math.round(prev * 0.5 + measured * 0.5)
}

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

async function summarize(older: Message[], deps: CompactDeps): Promise<string> {
  // GUARDED like the main model call (iterate-5: this was a raw complete() — one 300s backend wedge here
  // killed the whole round before the guarded main call was even made). Same policy: retry transients,
  // recycle the backend at ≥2 consecutive failures, reset the budget when the recycle verifies healthy.
  const res = await completeWithRecovery(
    () => deps.provider.complete({ messages: [{ role: 'user', content: serialize(older) }], model: deps.model, system: COMPACT_SYSTEM }, deps.signal),
    { signal: deps.signal, recover: deps.recover, sleep: deps.sleepForTest, onRetry: deps.onRetry },
  )
  return res.text.trim()
}

export interface CompactDeps {
  provider: ModelProvider
  model: string
  plan: CompactionPlan // ADR-039: thresholds + gated layers, derived from the model profile (ADR-038)
  signal?: AbortSignal
  /** Coupled curation (ADR-015): harvest durable facts from the OLDER messages before they're compressed. */
  onDiscard?: (older: Message[]) => Promise<void>
  /** Tokens the WIRE prompt carries beyond `messages`: system prompt + tool schemas + chat template. The plan's
   *  thresholds are window-relative, so ignoring this plans the whole window for messages. Measured live (8k
   *  window): ~4k of overhead ⇒ Ollama front-truncated the prompt to window−1 and left the model ONE token of
   *  output room (`inputTokens: 8191, outputTokens: 1`). The loop measures and passes it; default 0. */
  overheadTokens?: number
  /** WATCHDOG hook for the summarize call (same one the main loop uses — recycle a wedged backend). */
  recover?: () => Promise<void>
  /** Self-heal VISIBILITY (iterate-7: the babysitter double-recycled because in-flight summarize
   *  retries are invisible from outside) — wired by the session to a tracer error event. */
  onRetry?: (info: { attempt: number; delayMs: number }) => void
  /** Injectable backoff sleep for deterministic tests. */
  sleepForTest?: (ms: number) => Promise<void>
}

// The pure, no-LLM layers in escalation order, each mapped to the kind it reports. `summarize` is handled
// separately (it's async + needs the provider). Adding a layer later = one entry here + its transform.
const CHEAP_LAYERS: { layer: CompactionLayer; kind: CompactionKind; apply: (m: Message[], older: number, plan: CompactionPlan, shield: Set<string>) => Message[] }[] = [
  // collapse is unshielded on purpose: it only clears results a NEWER read of the same target supersedes —
  // the latest copy always survives, so there's no working-set loss even for a recent result.
  { layer: 'collapse', kind: 'collapsed', apply: (m, older) => collapseSuperseded(m, older) },
  { layer: 'mask', kind: 'masked', apply: (m, older, plan, shield) => maskObservations(m, older, plan.toolResultMaxChars, shield) },
  { layer: 'microcompact', kind: 'microcompacted', apply: (m, older, _plan, shield) => microcompactToolResults(m, older, shield) },
  { layer: 'snip', kind: 'snipped', apply: (m, older, plan, shield) => snipLargeToolInputs(m, older, plan.toolResultMaxChars, shield) },
]

/** Conservative estimate of the summary message's own size — used to decide whether summarizing HELPS. */
const EXPECTED_SUMMARY_TOKENS = 500

/** Plain text of a user message (string content or text blocks); undefined for tool_result-only messages. */
function userText(m: Message): string | undefined {
  if (m.role !== 'user') return undefined
  if (typeof m.content === 'string') return m.content || undefined
  const texts = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
  return texts.length > 0 ? texts.join('\n') : undefined
}

/** The FIRST (task statement) and LAST (latest instruction / harness steering nudge) plain-text user messages
 *  in the region, for VERBATIM preservation across a summarize. A prior summary message is unwrapped back to
 *  its task head (repeat compaction must not nest headers) and never counts as the "latest instruction". */
function preservedUserTexts(older: Message[]): { task?: string; lastInstruction?: string } {
  let task: string | undefined
  let taskIdx = -1
  for (let i = 0; i < older.length; i++) {
    const text = userText(older[i]!)
    if (!text) continue
    taskIdx = i
    // Repeat compaction: the first user text may BE a previous summary — keep only its original-task head.
    task = text.startsWith('[Original task]\n')
      ? text.split('\n\n[Earlier conversation compacted')[0]!.slice('[Original task]\n'.length)
      : text.startsWith('[Earlier conversation compacted')
        ? undefined
        : text
    break
  }
  for (let i = older.length - 1; i > taskIdx; i--) {
    const text = userText(older[i]!)
    if (!text || text.startsWith('[Original task]') || text.startsWith('[Earlier conversation compacted')) continue
    return { task, lastInstruction: text.slice(0, 2000) }
  }
  return { task }
}

/** First message index that contains a shielded tool_use or tool_result — the summarize boundary must not
 *  cross it, or the summary would eat the very results the cheap layers just protected. */
function firstShieldedIndex(messages: Message[], shield: Set<string>): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (typeof m.content === 'string') continue
    for (const b of m.content) {
      if ((b.type === 'tool_use' && shield.has(b.id)) || (b.type === 'tool_result' && shield.has(b.tool_use_id)))
        return i
    }
  }
  return messages.length
}

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
  // The wire prompt = overhead (system + tool schemas + template) + messages; all thresholds compare the SUM.
  const overhead = deps.overheadTokens ?? 0
  const usage = estimateTokens(messages) + overhead
  if (!force && usage < plan.auto) return { messages, kind: 'none' }

  const boundary = olderBoundary(messages, plan.keepRecentTokens)
  if (boundary === 0) return { messages, kind: 'none' } // all fits in the recent window — nothing older to compact

  // RECENCY SHIELD: the last N compactable results are the model's working set — eviction
  // layers skip them even when the token boundary says "older" (one big fresh read lands older instantly).
  // SURVIVAL MODE: at the ceiling (or reactive `force`) the prompt will NOT fit on the wire — Ollama silently
  // front-truncates it (the model loses its own history; measured: one 7-parallel-read turn hit 32k estimated
  // in an 8k window, the 5-wide shield left 21k standing, and the model came back lobotomized). Survival beats
  // recency: the shield shrinks to the very last result (a floor of 1). The ceiling is capped at
  // `effectiveWindow` because on enforced backends `num_ctx` covers prompt AND output together — messages up
  // to `hard`(=window on small plans) leave zero room to answer (measured: input 8191/8192, output 1 token).
  // Large windows are unaffected: there `hard < effectiveWindow` already.
  const ceiling = Math.min(plan.hard, plan.effectiveWindow)
  const survival = force || usage >= ceiling
  const shield = shieldedResultIds(messages, survival ? 1 : plan.keepRecentResults)
  // ADR-058: additionally shield the latest UNCONSUMED read per file (read, not yet acted on) — the flat
  // last-N shield is often shallower than one multi-read turn, and evicting a read the model hasn't used
  // yet forces the re-read loop. Capped + horizon-bounded inside; never in survival (survival beats recency).
  if (!survival) for (const id of unconsumedReadIds(messages)) shield.add(id)

  // ── Cheap layers: escalate, stopping as soon as we're back under threshold. ──
  // These are length-preserving (they clear content / stub inputs, never drop messages), so `boundary` stays
  // valid across all of them. `kind` tracks the most aggressive layer that actually reduced tokens.
  let working = messages
  let kind: CompactionKind = 'none'
  for (const step of CHEAP_LAYERS) {
    if (!plan.layers.has(step.layer)) continue
    const next = step.apply(working, boundary, plan, shield)
    if (estimateTokens(next) < estimateTokens(working)) {
      working = next
      kind = step.kind
    }
    if (!force && estimateTokens(working) + overhead < plan.auto) return { messages: working, kind }
  }

  // ── Heavy layer: LLM summary of the older half, recent kept verbatim. ──
  if (plan.layers.has('summarize')) {
    // Recompute the boundary: the cheap layers changed token counts, shifting where "recent" starts. Then
    // cap it at the shield (the summary must not eat the results the cheap layers just protected) and
    // turn-align it so `recent` starts on an assistant — summarize replaces `older` with one user message, so a
    // recent region beginning with a tool_result (or a user turn) would orphan a tool pair / stack two user
    // messages, which strict providers reject (see turnAlignedBoundary).
    const summarizeBoundary = turnAlignedBoundary(
      working,
      Math.min(olderBoundary(working, plan.keepRecentTokens), firstShieldedIndex(working, shield)),
    )
    if (summarizeBoundary > 0) {
      const older = working.slice(0, summarizeBoundary)
      const recent = working.slice(summarizeBoundary)
      // Only worth an LLM side-query if it can plausibly bring us back under `auto`. When the older region is
      // tiny (all the weight sits in shielded recent results), summarizing destroys context for no relief —
      // over-auto-but-under-HARD is a SOFT state: proceed as-is and let the next cycle (or a reactive force)
      // reclaim once newer work rolls the shield forward. Over hard there is no soft option (see survival above).
      const olderTokens = estimateTokens(older)
      const expectedSummary = Math.min(EXPECTED_SUMMARY_TOKENS, Math.floor(plan.window / 16)) // scale down for tiny windows
      const canHelp = estimateTokens(working) + overhead - olderTokens + expectedSummary < plan.auto
      // PRE-GATE (measured, json-repair-gate): with overhead counted, small-window usage hovers just over
      // `auto` late in a task, and every turn paid a summarize SIDE-QUERY (60–120s each on a local model —
      // two tasks timed out seconds from success). Worse, on a tiny older region the wrapper (task +
      // instruction + summary) can be BIGGER than what it replaces (observed: 2,114 → 2,797). Only spend the
      // LLM call when the older region is big enough to plausibly reclaim several times the wrapper cost.
      // `force` bypasses worth-it: the backend REJECTED the prompt, so even a marginal shrink helps (and the
      // monotonicity guard below still protects against a net-negative swap). WIRE SAFETY (measured,
      // item4-gate-2 delegate-prose): when the cheap layers reclaimed nothing (small results, old markers)
      // and the estimate is STILL over the ceiling, proceeding means silent front-truncation — Ollama never
      // errors, so the reactive-force path can't catch it (the fatal call showed input 8,159 + output 33 =
      // exactly 8,192). Over the ceiling, summarize is mandatory, worth-it or not.
      const stillOverCeiling = estimateTokens(working) + overhead >= ceiling
      const worthIt = force || stillOverCeiling || olderTokens >= expectedSummary * 3
      if ((survival || canHelp) && worthIt) {
        if (deps.onDiscard) await deps.onDiscard(older)
        // The ORIGINAL TASK and the LATEST USER INSTRUCTION ride along VERBATIM — never entrusted to the
        // summary. Measured failures: a weak model's summary lost the task statement and its next reply was
        // "please share the task you'd like me to work on" (window-gate-2, longctx-wire-modules); and a
        // just-injected steering nudge was summarized away before the model ever read it (delegateNudge test).
        // Folding them into the same user message is structural insurance and keeps the sequence valid.
        const { task, lastInstruction } = preservedUserTexts(older)
        let summary: string | undefined
        try {
          summary = await summarize(older, deps)
        } catch {
          // Summarizer unreachable even after retries + recycles. A dead round is worse than a lossy one:
          // fall back to DROPPING the older region, keeping the verbatim task + latest instruction (the
          // two things a summary must never lose anyway). The window is freed either way; the model can
          // re-read files it needs (they're on disk — observations are re-derivable, instructions aren't).
          summary = undefined
        }
        const summaryMsg: Message = {
          role: 'user',
          content: [
            task ? `[Original task]\n${task}` : '',
            summary
              ? `[Earlier conversation compacted to save context]\n\n${summary}`
              : '[Earlier conversation dropped to save context — its summary was unavailable. Re-read any file you need; the task above and instruction below are verbatim.]',
            lastInstruction ? `[Latest user instruction — still applies]\n${lastInstruction}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        }
        // MONOTONICITY GUARD: a summarize that doesn't SHRINK the history is pure loss (context destroyed,
        // side-query paid, tokens up). If the model wrote a long summary, keep `working` instead.
        const swapped = [summaryMsg, ...recent]
        if (estimateTokens(swapped) >= estimateTokens(working)) return { messages: working, kind }
        return { messages: swapped, kind: summary ? 'summarized' : 'dropped' }
      }
    }
  }

  return { messages: working, kind }
}
