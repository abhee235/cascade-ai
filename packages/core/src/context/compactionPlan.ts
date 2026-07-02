// context/compactionPlan.ts — sizing/thresholds for compaction as a PURE function of the model (ADR-039).
//
// The problem (ADR-039 Context): a flat ratio ("compact at 80% of window") regresses BIG models (reserves
// 40k on a 200k window) and under-serves SMALL ones. The fix is ONE parameterized plan whose large-window
// limit *is* the fixed absolute-buffer rule — so a strong model never regresses, by construction.
//
// Each tier is `max(proportional, absolute)`:
//   - LARGE windows are dominated by the ABSOLUTE branch (`effectiveWindow − buffer`).
//   - SMALL windows fall back to the PROPORTIONAL branch (`pct · window`) automatically.
// The buffer constants below pin the absolute branch exactly. The convergence is locked by a golden test
// (compactionPlan.test.ts).

import { contextWindowForModel } from '../llm/contextWindows'

// ── Buffer constants (the absolute branch) ───────────────────────────────────────────────────────────────
/** Tokens reserved for the compaction summary output. */
export const SUMMARY_OUTPUT_RESERVE = 20_000
/** Distance from effectiveWindow to the auto threshold. */
export const AUTOCOMPACT_BUFFER = 13_000
/** Distance from auto to warn. */
export const WARN_BUFFER = 20_000
/** Distance from effectiveWindow to hard. */
export const HARD_BUFFER = 3_000

// ── Small-window fallbacks ──────────────────────────────────────────────────────────────────
/** Proportional trigger used when the absolute branch goes degenerate on small windows. */
export const DEFAULT_PROPORTIONAL_PCT = 0.7
/** warn-pct = pct − this. */
export const WARN_PCT_OFFSET = 0.1
/** Fraction of the (effective) window kept verbatim as recent messages. */
export const DEFAULT_KEEP_RECENT_RATIO = 0.25

// A small window can't reserve a full 20k for the summary — cap the reserve at this fraction of the window.
// This also guarantees `auto ≤ effectiveWindow` (proven in the ADR): reserve ≤ 0.25·window ⇒ effectiveWindow
// ≥ 0.75·window ≥ 0.7·window = the proportional floor, so we always compact before exhausting the input budget.
const RESERVE_WINDOW_FRACTION = 0.25
// Big old tool outputs are masked to at most ~1% of the window (in chars); small windows mask harder.
const TOOL_RESULT_WINDOW_FRACTION = 0.01
const MIN_TOOL_RESULT_CHARS = 1_000
const MAX_TOOL_RESULT_CHARS = 8_000
/** Fallback window when the model is unknown and no override is set (matches the old ADR-012 default). */
export const DEFAULT_WINDOW = 8_192

/**
 * A compaction layer, run in escalation order until the history fits (ADR-039). Cheapest / least-lossy first:
 *   collapse      — clear results of SUPERSEDED reads/searches (dedupe; near-lossless)
 *   mask          — clear oversized old tool_result content (size gate)
 *   microcompact  — clear ALL remaining compactable tool_result content (evict observations)
 *   snip          — reclaim large tool_use INPUTS (Write/Edit/Bash bodies) → one-line stub
 *   summarize     — LLM side-query summary of the older half (the heavy, last resort)
 * The first four are pure/no-LLM and live in compactionLayers.ts.
 */
export type CompactionLayer = 'collapse' | 'mask' | 'microcompact' | 'snip' | 'summarize'

/** Every layer, in escalation order. The full stack (output-clearing layers plus input-reclaiming `snip`). */
export const ALL_COMPACTION_LAYERS: readonly CompactionLayer[] = [
  'collapse',
  'mask',
  'microcompact',
  'snip',
  'summarize',
]

export interface CompactionPlan {
  /** Total context window (tokens) this plan is sized for. */
  window: number
  /** Window minus the output reserve — the budget available for input + the summary. */
  effectiveWindow: number
  /** UI warn tier (tokens). */
  warn: number
  /** Auto-compaction trigger (tokens) — the load-bearing threshold. */
  auto: number
  /** Force-compaction tier (tokens); bounded by the window. */
  hard: number
  /** Keep this many of the most-recent tokens verbatim; older messages are compacted. */
  keepRecentTokens: number
  /** Max chars a single old tool_result may keep before it's masked. */
  toolResultMaxChars: number
  /** Which layers are enabled for this window size (cheapest first). */
  layers: Set<CompactionLayer>
  /** 'layered' = mask/summarize in place; 'fresh-context' = Ralph-style reset (tiny windows; deferred). */
  mode: 'layered' | 'fresh-context'
}

export interface PlanInput {
  /** Effective, allocated context window (tokens). */
  window: number
  /** Model's max output tokens — caps the summary reserve. Optional until ADR-038 profiles land. */
  maxOutputTokens?: number
  /** Proportional trigger fraction (default 0.7). */
  pct?: number
  /** Fraction of the effective window kept verbatim (default 0.25). */
  keepRecentRatio?: number
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * Derive a CompactionPlan from a window (+ optional profile hints). Pure — no I/O, safe to call repeatedly.
 *
 * Convergence guarantee: as `window → large`, the absolute branch dominates and `auto → window −
 * SUMMARY_OUTPUT_RESERVE − AUTOCOMPACT_BUFFER` (the fixed-buffer formula, exactly). See the golden test.
 */
export function planCompaction(input: PlanInput): CompactionPlan {
  const window = Math.max(0, Math.floor(input.window))
  const pct = clamp(input.pct ?? DEFAULT_PROPORTIONAL_PCT, 0, 1)
  const keepRecentRatio = clamp(input.keepRecentRatio ?? DEFAULT_KEEP_RECENT_RATIO, 0, 1)

  // Reserve for the summary output: the standard cap (20k), never more than the model can emit, never more than a
  // quarter of the window (so tiny models don't reserve their whole window). Large windows resolve to 20k.
  const reserveOutput = Math.min(
    SUMMARY_OUTPUT_RESERVE,
    input.maxOutputTokens ?? SUMMARY_OUTPUT_RESERVE,
    Math.floor(window * RESERVE_WINDOW_FRACTION),
  )
  const effectiveWindow = Math.max(0, window - reserveOutput)

  // max(proportional, absolute): absolute wins on big windows; proportional wins on small ones.
  const auto = Math.floor(Math.max(pct * window, effectiveWindow - AUTOCOMPACT_BUFFER))
  const warn = Math.floor(Math.max(0, Math.max((pct - WARN_PCT_OFFSET) * window, auto - WARN_BUFFER)))
  const hard = Math.floor(Math.min(window, Math.max(effectiveWindow - HARD_BUFFER, auto + HARD_BUFFER)))

  return {
    window,
    effectiveWindow,
    warn,
    auto,
    hard,
    keepRecentTokens: Math.floor(effectiveWindow * keepRecentRatio),
    toolResultMaxChars: clamp(
      Math.floor(window * 4 * TOOL_RESULT_WINDOW_FRACTION),
      MIN_TOOL_RESULT_CHARS,
      MAX_TOOL_RESULT_CHARS,
    ),
    layers: new Set<CompactionLayer>(ALL_COMPACTION_LAYERS), // full stack by default; the executor stops early
    mode: 'layered',
  }
}

/** Resolve a plan for a model: window = explicit override → known-model map → safe default. */
export function resolveCompactionPlan(opts: {
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  pct?: number
  keepRecentRatio?: number
}): CompactionPlan {
  const window = opts.contextWindow ?? contextWindowForModel(opts.model) ?? DEFAULT_WINDOW
  return planCompaction({
    window,
    maxOutputTokens: opts.maxOutputTokens,
    pct: opts.pct,
    keepRecentRatio: opts.keepRecentRatio,
  })
}
