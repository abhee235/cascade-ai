# ADR-050 — Delegation nudging: teaching weak models WHEN to delegate (rungs 1 + 2)

> **Status:** implemented (both rungs); rung-2 measurement recorded below/EVAL-BASELINE. Fifth measured
> harness change (047 → 048 → 049 → metrics/fixture → this), and the third instance of the
> detect→remind idiom (todo reminder ADR-034, verify gate ADR-049) — now a design signature of Cascade.

## Context — the delegation paradox

Delegation pays the most on small windows (bulk reads a subagent absorbs never bloat the parent), yet
USING it demands meta-cognition — recognize the situation, decompose, write a self-contained brief —
which is exactly what weak models lack, and what even strong models don't do unprompted. Measured:
**zero Subagent calls in all eval history (~60 tasks)**, including the `delegate-scatter` fixture built so
delegation wins (six 449-line vault shards vs a pinned 8k window; NEUTRAL prompt — we measure the choice,
we never instruct it).

The usual answer is ~2k tokens of when-to guidance in the delegation tool's prompt — description-level only,
frontier-audience. Cascade's old Subagent description explained only WHAT delegation is.

## Decision — move recognition down the harness, one rung at a time

**Rung 1 — imperative when-to in the tool description** ([Subagent.ts], tier-sized per ADR-037):
condition→action ("USE THIS whenever you would otherwise read multiple large files to find something
small — one 'explore' subagent per file, precise question"), a when-NOT list (known file → Read; targeted
search → Grep; ≤2 small files), and a fill-in-the-blank brief template (lowers the briefing burden — weak
models complete templates, they don't strategize).

**Rung 2 — the harness does the recognizing** ([delegateNudge.ts] + loop): the loop accumulates the token
estimate of successful Read/Grep/Glob results per submit; when it crosses **35% of the window** with zero
Subagent use, it appends ONE `<system-reminder>` ("for the remaining files, one 'explore' subagent per
target…") via the shared `appendReminder` and traces `delegate_nudge`. Guards: once per submit; needs a
known window (compaction plan) — so chat-only sessions skip; needs Subagent in the registry — so child
loops skip; `delegateNudge: false` opts out (LoopDeps + SessionOptions).

**Rung 3 — deferred deliberately**: budget-driven auto-delegation (Read refusing oversized files on small
windows / harness-spawned explore children, via ADR-038 `deriveBudgets`). Changes tool semantics; wants
rung-2 evidence first.

## Consequences (measured)

- **Rung 1 alone: no effect on behaviour.** Three fresh samples (2 trials + the Tier-1 gate's task):
  solved, **0 delegations**, ~1 compaction each; tokens 51.7k → ~47k (noise-level). The honest finding:
  *descriptions do not produce recognition, even at 35B* — which is what makes rung 2 necessary rather
  than speculative.
- **Rung 2: behaviour changed — but not the way hypothesized, and the truth is better.** The nudge fired
  1× in both trials (at ~26k read-tokens), and `subagentCalls` stayed **0** — yet the post-nudge trace
  shows the model immediately ABANDONED bulk reading and switched to `Grep "registerPart" src/vault`: the
  OPTIMAL strategy for this task (one targeted search extracts all six needles; cheaper than delegation,
  which needs six child inferences). Tokens: 51.7k (baseline) → ~47k (rung 1) → **~40.7k (rung 2, −21%)**;
  solved both trials; Tier-1 gate 11/11 exit 0. Interpretation: the nudge's real effect is *"stop burning
  your window"* — the model satisfied it with a better remedy than the one named. That is the harness's
  actual job, achieved in substance if not in the letter of `subagentCalls > 0`.
- **Fixture-design learning (recorded for the next cycle):** `delegate-scatter`'s needles share a greppable
  token (`registerPart`), so targeted search dominates delegation. Forcing TRUE delegation requires
  *comprehension-shaped* needles (facts with no common searchable pattern — e.g. "each shard's fragment is
  derivable only by reading its logic"), or real-repo tasks where Grep genuinely can't substitute. Until
  such a fixture exists, `subagentCalls` remains a visibility metric, not a target.
- **Rung 3 verdict: stays deferred, evidence-based** — the nudge already recovers the wasted context on
  this class of task; auto-delegation should wait for a task class where search cannot substitute (most
  likely from the builder track's real repos).
- Tests: 6 through the real loop (fires once under pressure; silent without window/Subagent/opt-out) +
  pure fold/detect helpers. Core suite green (a concurrent-load timeout in a server test was ruled out —
  passes in 311ms in isolation).
- **Tier-1 note:** `delegate-scatter` joined the default suite → the gate baseline is now 11 tasks.

[Subagent.ts]: ../../packages/core/src/tools/builtins/Subagent.ts
[delegateNudge.ts]: ../../packages/core/src/agent/delegateNudge.ts
[EVAL-BASELINE.md]: ../EVAL-BASELINE.md
