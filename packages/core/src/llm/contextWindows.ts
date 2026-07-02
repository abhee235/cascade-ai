// llm/contextWindows.ts — best-effort model → context-window map (ADR-012). Used to size compaction when the
// user hasn't set cascade.contextWindow. Hosted models have known windows; local (Ollama) is a GUESS — its
// usable window is actually `num_ctx` (often 4k) regardless of the model's trained max, so for local models
// prefer the cascade.contextWindow override. Auto-detect via /api/show is deferred.

// NOTE (ADR-039/038): the *usable* window is the model's allocated `num_ctx`, NOT its trained max — and two
// variants of the same base can differ (qwen36-agentic pins num_ctx 32k via its Modelfile; coding-qwen36 pins
// 128k). This static map can't see that, so SPECIFIC variants must precede the generic family rule (first match
// wins). The real fix is /api/show `num_ctx` auto-detection (ADR-038, deferred) — which would retire this map.
const WINDOWS: [RegExp, number][] = [
  [/gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|o4/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/claude/i, 200_000],
  [/coding-qwen ?3\.?6/i, 131_072], // coding-qwen36: Modelfile num_ctx 131072 (128K) — MUST precede the generic qwen36 rule
  [/qwen ?2\.5|qwen ?3|qwen2|qwen36/i, 32_768],
  [/llama ?3|llama3/i, 8_192],
  [/mistral|mixtral/i, 32_768],
  [/gemma ?2|gemma/i, 8_192],
  [/deepseek/i, 32_768],
  [/phi ?3|phi3/i, 4_096],
]

/** A known window for the model, or undefined (caller falls back to a configured value or a safe default). */
export function contextWindowForModel(model: string): number | undefined {
  for (const [re, win] of WINDOWS) if (re.test(model)) return win
  return undefined
}

// ── Window tiers (ADR-037 / ADR-039) ────────────────────────────────────────────────────────────────────────
// One coarse switch shared by the system-prompt generator (how rich a prompt the window can afford) and the
// compactor (recorded on the plan). "abundance becomes scarcity" is continuous, but a few behaviours want a
// discrete band. Boundaries are deliberate: 32k/64k must SPEND their window on the task, so they get a lean
// prompt; 128k+ can afford the full behavioural prompt. 128k lands in `full` — its own rules vs the 32k `lean`.
export type WindowTier = 'minimal' | 'lean' | 'full'
/** Below this a rich preamble would eat too much of the window → strip to essentials. */
export const MINIMAL_TIER_MAX = 24_000
/** At/above this the full behavioural prompt is affordable (128k, 200k, 1M). Below → lean (32k, 64k). */
export const FULL_TIER_MIN = 96_000

/** Map an allocated context window (tokens) to a coarse tier. 8k→minimal, 32k/64k→lean, 128k/200k→full. */
export function windowTier(window: number): WindowTier {
  if (window < MINIMAL_TIER_MAX) return 'minimal'
  if (window < FULL_TIER_MIN) return 'lean'
  return 'full'
}
