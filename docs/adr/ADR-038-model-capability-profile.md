# ADR-038 — Model-capability profile → adaptive runtime budgets (feeds CORE-PARITY A2 / A3 / A6)

> **Status:** accepted, not yet implemented. This ADR defines the shared input that A2 (compaction), A3
> (recovery/token-escalation), and A6 (context engineering) should consume instead of each inventing its own
> thresholds. Build order + verification land with those items.

## Context

Frontier-model coding agents are **mono-target** harnesses: their algorithms carry constants tuned for one
regime — a very large context window (200k–1M) and a frontier model that reliably uses the native tool-call
channel. Those constants are invisible *assumptions of abundance*:

- a rich system prompt + a project instruction file + directory tree + git status injected every session;
- ~40 tool schemas advertised inline, only deferred via a tool-search tool past a high threshold;
- whole-file reads up to 2000 lines;
- late compaction;
- large edits / full-file writes, assuming the reply can't be truncated;
- tool calls that always arrive on the function channel, often several per turn.

Cascade targets the **opposite** regime — small local models (e.g. a 32k window with an 8k output cap, and
tool-calling that is unreliable or prose-only). Every assumption above **inverts**: on a 32k window such a
preamble alone can consume 30–50% *before turn 1*; a 2000-line read can blow the window; an 8k output cap can
truncate a full-file `Write` **mid-file → corruption**; a prose-only model emits tool calls the loop never
sees, so it quits early ([[model-capability-fallbacks]]).

Cascade already has the *seed* of the fix but narrow and scattered: `contextWindowForModel(model)`
([contextWindows.ts]) and `CompactConfig { window, compactRatio, keepRecentRatio }` ([compactor.ts:12]) — but
`window` is consumed **only** by the compactor, and the [`ModelProvider`][provider.ts] interface exposes
**zero** capability metadata. There is no single place that answers "what is this model actually capable of,
and how should the algorithm bend to fit?"

**A load-bearing gap found while writing this ADR.** The Ollama provider's request body ([openaiCompat.ts
`body()`]) sets `model / messages / stream / tools` but **never sets `num_ctx` or `num_predict`**. Ollama does
**not** allocate a model's *max* context unless asked — it uses its own default (historically 2k–4k). So
`contextWindowForModel` may claim 32k while Ollama silently runs at 4k, truncating the prompt into garbage and
making the compactor "protect" a window that does not exist. **Effective window is an allocation choice, not a
model fact** — and today Cascade doesn't make it explicitly. This ADR treats the profile's `contextWindow` as
the *allocated* window and requires the provider to enforce it.

## Decision

Introduce a **two-layer capability model**: raw facts in, derived operating knobs out — the algorithm reads
only the derived knobs, so all adaptation logic lives in one pure, testable function.

### 1. `ModelProfile` — raw capabilities ([llm/modelProfile.ts], new)

```ts
export interface ModelProfile {
  model: string
  contextWindow: number      // EFFECTIVE, ALLOCATED tokens (= num_ctx the provider will request) — not model max
  maxOutputTokens: number    // num_predict cap
  nativeToolCalls: boolean   // reliably uses the function-calling channel? (drives parse strategy)
  parallelToolCalls: boolean // safe to emit >1 tool_use per turn?
  reasoning: boolean         // emits a thinking channel?
  vision: boolean
  tokensPerChar?: number     // estimator calibration (default ~0.25; code/JSON undercounts — stay conservative)
}
```

Resolution order (single source of truth): **explicit config override → Ollama `/api/show` discovery →
known-model map ([contextWindows.ts]) → conservative defaults.** `/api/show` yields the architecture context
length + parameters; `nativeToolCalls` and a deliberately-smaller allocated window are config-only (not
detectable). The profile is resolved **once at session start** ([session.ts]).

### 2. `deriveBudgets(profile)` — pure fn → operating knobs ([llm/deriveBudgets.ts], new)

```ts
export interface RuntimeBudgets {
  inputBudget: number            // window − reserveOutput − safetyMargin (history never crowds out the reply)
  reserveOutput: number
  compactAtTokens: number        // compact EARLIER on small windows
  keepRecentTokens: number
  toolResultMaxChars: number     // truncate tool output harder on small windows
  maxFileReadChars: number       // chunk Read instead of slurping whole files
  systemPromptTier: 'full' | 'lean' | 'minimal'
  advertiseToolsInline: boolean  // false on tiny windows → defer via ToolSearch / curated subset
  memoryRetrievalK: number
  editStrategy: 'rewrite-ok' | 'diff-only'   // small output cap → forbid full-file Write
  parseStrategy: 'native' | 'json-repair' | 'prose-fallback'
  compactionMode: 'summarize' | 'fresh-context'  // small window → Ralph-style reset over summarizing
  tier: 'frontier' | 'midsize' | 'constrained'   // coarse switch for whole-strategy branches
}
```

Pure, no I/O, unit-tested across the 8k↔1M range. `CompactConfig` becomes **derived from** the profile, not a
separate hand-tuned input.

### 3. Threading

Add `profile: ModelProfile` to [`LoopDeps`][agentLoop.ts]; the loop derives `budgets` once and the consumers
read it — each row here fixes one inverted abundance assumption:

| Consumer | Reads | Fixes the assumption |
|---|---|---|
| [compactor.ts] | `compactAtTokens`, `keepRecentTokens`, `toolResultMaxChars`, `compactionMode` | late compaction; fixed 2000-char mask |
| [systemPrompt.ts] | `systemPromptTier`, `advertiseToolsInline`, `memoryRetrievalK` | rich preamble + 40 inline tool schemas |
| `Read` builtin | `maxFileReadChars` | whole-file 2000-line reads |
| provider (parse) | `parseStrategy`, `parallelToolCalls` | native-tool-call-only assumption |
| recovery / edit | `reserveOutput`, `maxOutputTokens`, `editStrategy` | truncation-corruption on an 8k output cap |

### 4. Provider must **enforce** the allocated window

The provider request body sets `options.num_ctx = profile.contextWindow` and
`options.num_predict = profile.maxOutputTokens`. Because the OpenAI-compat `/v1` endpoint does not expose
`num_ctx`, this requires the native `/api/chat` `options` path (or a documented Modelfile `PARAMETER num_ctx`).
The invariant: **`profile.contextWindow` equals the tokens the model is actually given** — otherwise every
downstream budget is computed against a fiction.

## Consequences

- **Capability-adaptive, not mono-target.** The same algorithm runs a 32k/8k local model and a 200k frontier
  model by swapping one profile — a deliberate step *beyond* mono-target harnesses, not parity with them. Aligns with the
  weak-model harness thesis: on a small model, *abundance becomes scarcity*, so every constant becomes a
  function of the profile.
- **One place to reason and test.** Adaptation logic is a pure function; tuning is a data change, not a hunt
  through the loop. A2/A3/A6 stop each inventing thresholds and consume `budgets`.
- **Closes the silent-truncation class** once the provider enforces `num_ctx`/`num_predict` — today's latent
  gap where the harness protects a window the model isn't given.
- **Seams unchanged.** `profile` is an injected `LoopDeps`/context field like `sandbox`/`archival`/
  `readFileState`; absent ⇒ fall back to today's `resolveCompactConfig` defaults, so headless smoke tests stay
  simple.
- **Deferred / caveats (handle when the consumers land):** token estimation stays chars-based — keep a
  **conservative safety margin** since code/JSON undercounts; `nativeToolCalls` and the prose/JSON-repair
  fallback are provider-local ([[model-capability-fallbacks]]); don't over-knob — ship only the load-bearing
  budgets in the table above, each with a test.

## Prior art — an open-source coding CLI (independent validation)

An open-source, multi-provider coding CLI targets the same range — Qwen models incl. local Ollama/vLLM — and
independently built most of this design. Confirms the inputs; its scatter confirms our two-layer split is the
cleaner shape.

- **Token-limit resolution = our profile inputs.** Its token-limit module resolves `contextWindow` **and**
  `maxOutputTokens` via ordered regex tables over a normalized model name, with a default window of
  `131072`, a default output limit of `32000`, and an **escalated max of `64000`** (A3 as a constant).
  The normalization strips **quantization/precision suffixes** (`-int4`, `-q4`, `-bf16`, `-quantized`) +
  date/version tags — exactly what our `/api/show` resolution needs for local model ids. Resolved **once, then
  read from the generator config after** — our "resolve at session start" pattern.
- **Compaction already degrades gracefully by window = our thesis, live.** Its compression service runs a
  **three-tier ladder** (`warn/auto/hard`) computed from the window: **absolute buffers taken from an
  established frontier agent** (`AUTOCOMPACT_BUFFER=13k`, `WARN_BUFFER=20k`, `HARD_BUFFER=3k`,
  `SUMMARY_RESERVE=20k`) **plus a proportional fallback** (`DEFAULT_PCT=0.7`) that engages when the window is so
  small that the absolute branch would become degenerate. `effectiveWindow = window − SUMMARY_RESERVE` is our
  `reserveOutput`. Also: a cheap-gate + a 3-consecutive-failures breaker, a rule-based fast-compression tier,
  and a **CJK-aware estimator** (`×1.5`) — a concrete upgrade over our chars/4 for Qwen models.
- **What it DOESN'T do (our edge holds).** Auditing every consumer of its window size: it drives compaction,
  output escalation, and a context-usage meter — **never the system prompt or tool advertisement.** So our
  `systemPromptTier` / `advertiseToolsInline` budgets go beyond it; keep them.
- **Architecture delta.** It has no single `ModelProfile` and no pure `deriveBudgets()` — capabilities are
  spread across `tokenLimits.ts`, `models/types.ts` (`ModelCapabilities { vision }`, admittedly "not read"),
  and generation config. Our facts→derive split stays.

## Follow-ups

- **Verify the `num_ctx` gap first** ([openaiCompat.ts]) — it is load-bearing for every budget; no point tuning
  ratios against a window the model isn't actually allocated.
- Wire `deriveBudgets` into A2 (compaction stack), A3 (token escalation / budget continuation), A6 (prompt +
  context engineering) as those ADRs are written; add a CORE-PARITY row pointing back here.
- `parseStrategy: 'prose-fallback'` depends on the text-channel tool-call parser (tracked separately).
- **A2 (compaction) should adopt that hybrid absolute+proportional ladder** so the big-window path reproduces
  the established frontier-agent thresholds exactly (no regression) while small windows fall back to
  proportional — one parameterized algorithm, not two compactors. Port the model-id normalization, add a
  CJK-aware estimate + a fast rule-based compression tier, and add a **golden test asserting large-window
  thresholds equal the reference values.**

[provider.ts]: ../../packages/core/src/llm/provider.ts
[compactor.ts]: ../../packages/core/src/context/compactor.ts
[contextWindows.ts]: ../../packages/core/src/llm/contextWindows.ts
[agentLoop.ts]: ../../packages/core/src/agent/agentLoop.ts
[systemPrompt.ts]: ../../packages/core/src/agent/systemPrompt.ts
[session.ts]: ../../packages/core/src/session.ts
[openaiCompat.ts `body()`]: ../../packages/core/src/llm/providers/openaiCompat.ts
[llm/modelProfile.ts]: ../../packages/core/src/llm/modelProfile.ts
[llm/deriveBudgets.ts]: ../../packages/core/src/llm/deriveBudgets.ts
