# ADR-039 — Layered, plan-driven compactor (CORE-PARITY A2; consumes ADR-038)

> **Status:** accepted; **implemented.** Threshold ladder + convergence/golden test **and** the full layer
> stack — `collapse` (dedupe superseded reads/searches), `mask` (size-gated), `microcompact` (evict compactable
> tool results), `snip` (reclaim large tool *inputs*), `summarize` (LLM). The pure layers live in
> [compactionLayers.ts]. Only `fresh-context` (Ralph) mode and wiring the real ADR-038 `ModelProfile.
> maxOutputTokens` remain deferred.

## Context

Our Phase-11 compactor ([compactor.ts], ADR-012) sizes compaction with two flat ratios — `compactRatio = 0.8`
(compact when tokens ≥ 80% of window) and `keepRecentRatio = 0.25`. That is a **proportional-only** policy, and
it is wrong at both ends of the range Cascade must serve (it is multi-provider — a 200k frontier model *and* a 32k
local Qwen):

- **Big models regress.** 80% of a 200k window reserves **40k tokens** of headroom you never needed; frontier
  agents compact at `window − 13k` (≈93.5%), wasting only ~33k *total* including the output reserve. Proportional
  reservation *scales with the window*, so the bigger and stronger the model, the more context we throw away.
- **Small models are under-served.** A single flat ratio can't express "reserve output tokens," "mask tool
  output harder," or "compact earlier" — all of which a 32k/8k model needs.

The fear when fixing this is a real one: *optimize for small models and you regress the big ones.* The
resolution is **not** two compactors with a switch (double the bugs; the switch boundary is the fragile part).
It is **one parameterized compactor whose large-window limit *is* the established frontier-agent
behavior** — so a strong model runs the same path it runs today, by construction.

**Prior art (re-read for this ADR):**
- The established frontier-agent thresholds: max summary output `20_000`, auto-compact buffer `13_000`,
  warning buffer `20_000`, manual-compact buffer `3_000`; `threshold = effectiveWindow − AUTOCOMPACT_BUFFER` —
  pure **absolute**, no proportional term (it assumes abundance).
- An open-source coding CLI's threshold computation (ADR-038 prior art): a three-tier ladder where
  each tier is `max(proportional, absolute)`, so small windows fall back to the proportional branch automatically
  while large windows are dominated by the absolute branch. This is the proven shape; we port it.

## Decision

A **`CompactionPlan`** — the pure, derived output of the model profile (ADR-038) — is the single input the
compactor reads. One executor runs the enabled layers against the plan's thresholds.

### 1. `planCompaction()` — pure, the ladder ([context/compactionPlan.ts], new)

```
reserveOutput   = min(SUMMARY_OUTPUT_RESERVE=20k, maxOutputTokens ?? 20k, floor(window * 0.5))
effectiveWindow = max(0, window − reserveOutput)
auto = max(pct·window,                       effectiveWindow − AUTOCOMPACT_BUFFER)   // pct default 0.7
warn = max(0, max((pct−0.1)·window,          auto − WARN_BUFFER))
hard = min(window, max(effectiveWindow − HARD_BUFFER, auto + HARD_BUFFER))
keepRecentTokens   = floor(effectiveWindow * keepRecentRatio)   // default 0.25
toolResultMaxChars = clamp(floor(window * 4 * 0.01), 1000, 8000) // small windows mask harder
```

Buffer constants are **taken from the established absolute thresholds** so the absolute branch reproduces them
exactly. `reserveOutput` improves on that CLI's fixed 20k: an 8k model can't reserve 20k, so we cap it at half
the window (the `floor(window*0.5)` term), while a large window still resolves to exactly 20k → **large-window
behavior preserved**.

### 2. `CompactionPlan` also carries behavior gates

```ts
interface CompactionPlan {
  window; effectiveWindow; warn; auto; hard
  keepRecentTokens; toolResultMaxChars
  layers: Set<'mask' | 'summarize'>   // extensible: snip / microcompact / context-collapse later
  mode: 'layered' | 'fresh-context'   // the ONLY true strategy branch (tiny windows; deferred)
}
```

Small-window adaptation is expressed by **turning cheap layers on / thresholds down**, never by turning the
big-model layers off. `mode: 'fresh-context'` (Ralph-style reset over summarizing) is reserved for the ~8k
extreme and is a deferred follow-up — not half-built.

### 3. The compactor consumes the plan ([compactor.ts])

`compactIfNeeded(messages, deps, { force? })` reads `plan.auto` (trigger), `plan.keepRecentTokens` (boundary),
`plan.toolResultMaxChars` (mask aggressiveness), and runs only the layers in `plan.layers`. `force: true`
(reactive overflow, [agentLoop.ts]) bypasses the threshold gate — replacing the old hack of mutating
`compactRatio` to 0.6. `CompactDeps.config` becomes `CompactDeps.plan`; `resolveCompactionPlan()` resolves the
window (override → `contextWindowForModel` → default) and calls `planCompaction`.

### 4. No-regression guarantee (the point of the whole ADR)

- **Convergence by construction.** As `window → large`, the absolute branch dominates every tier, so the plan
  converges to the reference values (`auto = window − reserveOutput − 13k`).
- **Golden test** ([compactionPlan.test.ts]): asserts the **`auto` trigger is bit-exact with the reference** on
  big windows — `planCompaction({ window }).auto === window − 20_000 − 13_000` for 131k/200k/1M. `auto` is the
  thing that regresses a strong model, so it is pinned exactly. `warn` (a softer UI tier) equals the reference
  `auto − WARN_BUFFER` once the absolute branch dominates (≥200k); below the ~132k crossover the proportional floor (`0.6·window`) may
  nudge `warn` slightly later — harmless, and what keeps `warn` useful on small windows. Any future small-model
  tweak that shifts the big-window `auto` fails CI. This test turns "I'm afraid big models regress" into a
  checked invariant. (Writing it immediately caught a 571-token `warn` divergence at exactly 128k — the tripwire
  working as designed.)

## Consequences

- **One codebase, profile decides.** A 200k frontier model gets late absolute thresholds (the reference
  behavior); a local 32k Qwen gets the proportional branch + harder tool-output masking; a 1M-window model gets
  an even-later threshold — all the same executor. Directly serves the multi-provider requirement.
- **Big models stop losing context** (≈33k reserved vs 40k at 200k, and the gap widens with window size).
- **Full stack, escalating, cheapest-first.** `collapse → mask → microcompact → snip` run with no LLM, stopping
  the moment history fits; only then does `summarize` fire. The returned `kind` names the most aggressive layer
  that ran, surfaced to the user via `compactionKindLabel`.
- **Beyond the usual design for local models.** The usual cheap layers only ever clear tool *outputs*; `snip`
  additionally reclaims large tool *inputs* (Write/Edit file bodies, long Bash scripts) — usually the single biggest reclaimable item
  in a coding session — stubbing them to a one-line record so the model keeps the fact it acted. And it's fully
  automatic (weak models won't reliably self-prune, unlike a model-invoked snip tool).
- **Extensible without forking.** Each layer is a pure transform in [compactionLayers.ts] + one entry in the
  executor's `CHEAP_LAYERS` table; adding another is local.
- **Deferred:** `fresh-context` (Ralph) mode for the ~8k extreme; wiring `maxOutputTokens` from the real ADR-038
  `ModelProfile` (today it's accepted optionally and the reserve is defaulted); CJK-aware token estimate.
- **Behavior change to note:** default trigger moves from a flat 80% to the threshold ladder (later on big
  windows, ~70% floor on small). Intended.

## Verification

- Unit (pure): golden large-window parity with the reference thresholds; small-window (32k/8k) falls to the
  proportional branch; monotonic `warn ≤ auto ≤ hard ≤ window`; `reserveOutput` capping for tiny windows.
- Behavioral: existing `compactor.test.ts` phases (mask-only, summarize) re-pass under the plan shape; reactive
  `force` path compacts under threshold.
- Boundary safety: `summarize` **turn-aligns** its split (`turnAlignedBoundary`) so `recent` always starts on an
  assistant message — it never orphans a `tool_result` from its `assistant(tool_use)` nor stacks two `user`
  messages (both a hard 400 on strict hosted APIs such as OpenAI; silently accepted by Ollama, so latent on the
  local backend).
  Regression test asserts `recent[0].role === 'assistant'` and zero orphaned tool_results.
- (Follow-up) live app: drive a small-window model to auto-compaction and confirm the loop shrinks history.

## Follow-ups

- Implement `mode: 'fresh-context'` for the ~8k extreme (pairs with the Ralph-loop idea).
- Consume the real ADR-038 `ModelProfile.maxOutputTokens`; add CJK-aware estimation.
- Optional: a model-invoked `Snip` tool (as some agents offer) so the model can prune on demand, complementing the
  automatic `snip` layer.

[compactor.ts]: ../../packages/core/src/context/compactor.ts
[context/compactionPlan.ts]: ../../packages/core/src/context/compactionPlan.ts
[compactionPlan.test.ts]: ../../packages/core/test/compactionPlan.test.ts
[agentLoop.ts]: ../../packages/core/src/agent/agentLoop.ts
