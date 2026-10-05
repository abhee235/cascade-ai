// llm/contextWindows.ts — best-effort model → context-window map (ADR-012). A FALLBACK now: the session first
// tries provider.detectModelLimits() (ADR-038 — Ollama /api/show num_ctx, ground truth) and only lands here when
// that returns nothing (a hosted backend with no /api/show, or a model with no Modelfile num_ctx). Hosted models
// have known windows; local guesses stay conservative. An explicit cascade.contextWindow override beats both.

// NOTE (ADR-039/038): the *usable* window is the model's allocated `num_ctx`, NOT its trained max — and two
// variants of the same base can differ (qwen36-agentic and coding-qwen36 both pin 128k via their Modelfiles;
// the generic qwen rule stays 32k). This static map can't see that, so SPECIFIC variants must precede the generic family rule (first match
// wins). The real fix is /api/show `num_ctx` auto-detection (ADR-038, deferred) — which would retire this map.
const WINDOWS: [RegExp, number][] = [
  [/gpt-6-luna/i, 1_050_000], // gpt-6-luna: 1.05M total (922k input + 128k output) — developers.openai.com/api/docs/models/gpt-6-luna
  [/gpt-5/i, 400_000], // gpt-5 / 5-mini / 5-nano / 5.x: 400k total (272k input + 128k output)
  [/gpt-4\.1/i, 1_000_000], // gpt-4.1 family: ~1M context — must precede the generic gpt-4 rules
  [/\bo[134]\b|\bo[134]-/i, 200_000], // o1/o3/o4(-mini): 200k. \b so "gpt-4o"/"llama3" never match
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/claude/i, 200_000],
  // ── Hosted large-context coder models (NVIDIA NIM / OpenRouter / Together). These are NATIVE windows;
  //    detectModelLimits can't probe a hosted backend (Ollama-only), so without these a NIM model like
  //    moonshotai/kimi-k2-instruct falls to DEFAULT_WINDOW (8k) and compacts ~16× too early. A specific NIM
  //    endpoint MAY serve less than native — override with CASCADE_CONTEXT_WINDOW / cascade.contextWindow.
  //    Each must precede the generic same-family local rule below (first match wins). Verified 2026-07-20. ──
  [/kimi[ ._-]?k2\.[56]/i, 262_144], // Kimi K2.5 / K2.6: 256k
  [/kimi.*k2.*(0905|thinking)/i, 262_144], // Kimi K2 Instruct-0905 / K2 Thinking: 256k (marker may follow "instruct")
  [/kimi[ ._-]?k2/i, 131_072], // Kimi K2 Instruct (base): 128k — must follow the 256k variants above
  [/qwen ?3-?coder/i, 262_144], // Qwen3-Coder-480B-A35B: 256k native — MUST precede the generic qwen 32k rule
  [/deepseek[ ._-]?(v3|r1|chat)/i, 131_072], // DeepSeek V3 / V3.1 / R1: 128k — MUST precede the generic deepseek 32k rule
  [/llama[ ._-]?(3\.[13]|4|nemotron)/i, 131_072], // Llama 3.1 / 3.3 / 4 / Nemotron (common on NIM): 128k
  [/coding-qwen ?3\.?6/i, 131_072], // coding-qwen36: Modelfile num_ctx 131072 (128K) — MUST precede the generic qwen36 rule
  [/qwen ?36-agentic/i, 131_072], // qwen36-agentic: Modelfile num_ctx raised 32k → 131072 (2026-07-19, the Simmer live-lock: 16 compactions in 53 turns at 32k)
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
