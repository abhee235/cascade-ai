# ADR-047 — Prose tool-call fallback (the eval's first measured fix)

> **Status:** implemented. The first harness change driven end-to-end by the eval instrument
> (PLAN-eval): baseline exposed it, traces localized it, the diff quantifies it. Eval delta below.

## Context

The weak-tier eval baseline (`baseline-llama32-3b`, PLAN-eval E5) scored **0/10 — every failure the same
class, `no_tool_use`**. The traces showed the model was not refusing to act: it emitted well-formed calls —

```json
{ "name": "Glob", "parameters": { "pattern": "src/**/*.js", "path": "src" } }
```

— but inside a ```json fence in its **text**, never on the native tool-call channel. Small/older models
often can't drive the OpenAI function-calling channel reliably; they were trained to write calls as text.
The loop detects tool use only by the presence of native `tool_use` blocks (ADR-005), so it saw a
turn with zero calls → terminal answer → task over at turn 1. Frontier-model harnesses never need this
(frontier models drive the native channel); for a multi-provider, weak-model-first harness it is the single
highest-leverage reliability fix — predicted in [[model-capability-fallbacks]], now measured.

## Decision

A **provider-level fallback** ([proseToolCalls.ts], wired into both stream paths of [openaiCompat.ts]):
after a stream ends, **if the native channel produced zero tool calls**, scan the accumulated text for
tool-call JSON and emit the first valid hit as a synthetic `tool_use` (id `prose_0`, stopReason
`tool_use`). The loop is untouched — per the established seam rule, capability fallbacks live in the
provider, not the loop.

**The extractor** (pure, unit-tested on the *actual* 3b payload): handles ```json fences /
`<tool_call>` tags / bare objects / arrays / the OpenAI-echo shape (`function.arguments` as a JSON
string); string-aware brace scanning (multiple back-to-back objects — the observed shape — are not valid
JSON as a whole); accepts `parameters|arguments|input|args` argument keys and `name|tool` name keys.

**Three safety properties** (why strong models are unaffected — verified by the no-regression diff):
1. **Zero-native gate** — never runs when the model used the real channel.
2. **Advertised-names-only** — a candidate must name a tool offered *this turn*; hallucinated tools
   (the 3b invented `Rename`) and call-shaped prose are dropped.
3. **First-call-only (ReAct)** — weak models emit whole speculative sequences up front (the 3b's
   included an `Edit` with empty `old_string` and a `Write` with placeholder content); executing beyond
   the first call would act on guesses. One call → real result → the model re-plans with information.

## Consequences

- **Eval delta (measured, honest):** weak tier (`prose-fallback-3b`): solves **0/10 → 0/10** — but the
  target class collapsed: **`no_tool_use` 10 → 1**. The 3b went from dead-at-turn-1 (0 tool calls, ever) to
  real agent loops (up to 17 turns / 16 tool calls / 5 live compactions); failures moved DOWN the ladder to
  `invalid_args` (4) and `false_done` (5) — each already mapped to its next knob (arg coercion / verify
  prompt in the minimal tier). Climbing the ladder one measured class at a time is the intended outcome.
- **Strong-tier no-regression (gate exercised for real):** the first `prose-check-agentic` run flipped the
  borderline `longctx-changelog-version` task (9/10, gate exit 1 — push blocked). Forensics: **zero
  `prose_0` ids in any trace** — the fallback provably never executed for the strong model — and a 2-trial
  resample of the task passed **2/2** with the fallback in the build. Verdict: single-run nondeterminism on
  the suite's known-borderline task, not a regression. Lesson recorded: gate that task at `--trials 2`.
- The raw JSON text remains in the assistant message (it streamed live before the fallback could know);
  harmless next to the appended tool_use + result. Stripping it retroactively would fight streaming.
- **Deferred:** JSON *repair* for near-miss arguments (trailing commas etc. — a different failure class,
  `invalid_args`); multi-call batching for read-only sequences; wiring this as ADR-038's
  `parseStrategy: 'prose-fallback'` knob once profiles carry `nativeToolCalls`.

[proseToolCalls.ts]: ../../packages/core/src/llm/proseToolCalls.ts
[openaiCompat.ts]: ../../packages/core/src/llm/providers/openaiCompat.ts
[EVAL-BASELINE.md]: ../EVAL-BASELINE.md
