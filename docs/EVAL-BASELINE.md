# Eval baselines (PLAN-eval E5)

> The reference numbers every harness ADR diffs against (`npm run eval:report -- --diff <baseline> <after>`;
> exit 1 = regression). Suite: the 10 Tier-1 tasks in `eval/tasks/` (2× edit / feature / fix / search /
> longctx), 1 trial, temperature 0, `bypass` permissions, `autoMemory:false`. Runs live in `eval/runs/`
> (gitignored); this doc records the numbers + findings.

## The curve (2026-07-03)

| Tier | Model | Solved | Failure classes | Notes |
|---|---|---|---|---|
| **strong (35B, 32k)** | `qwen36-agentic:latest` | **10/10** | — | label `baseline-qwen36-agentic` — **the reference baseline** |
| strong (35B, 128k) | `coding-qwen36:latest` | **9/10** | 1× `false_done` | label `baseline-coding-qwen36` |
| mid (20B) | `gpt-oss:20b` | **7/11 (64%)** | 2× `false_done`, 1× `invalid_args`, 1× `loop_stall` | label `baseline-gpt-oss-20b` — fails by GRINDING (176k tok/27 turns on wire-modules vs the 35B's 5 turns) |
| weak (3B) | `llama3.2:3b` | **0/10** | 10× `no_tool_use` | label `baseline-llama32-3b` |

### baseline-qwen36-agentic — 10/10, per task

| task | solved | s | turns | tools(err) | tokens | compactions |
|---|---|---|---|---|---|---|
| edit-fix-pagination | ✅ | 21 | 4 | 4(0) | 21.1k | 0 |
| edit-rename-function | ✅ | 15 | 4 | 5(0) | 21.5k | 0 |
| feature-add-command | ✅ | 16 | 6 | 7(0) | 33.4k | 0 |
| feature-stats-module | ✅ | 19 | 5 | 6(0) | 27.6k | 0 |
| fix-empty-cart | ✅ | 22 | 6 | 6(1) | 33.2k | 0 |
| fix-format-duration | ✅ | 18 | 4 | 4(0) | 21.6k | 0 |
| longctx-changelog-version | ✅ | 37 | 7 | 9(0) | 48.5k | **1** |
| longctx-wire-modules | ✅ | 14 | 5 | 5(0) | 23.1k | 0 |
| search-negative-amount | ✅ | 21 | 4 | 5(0) | 22.1k | 0 |
| search-retry-default | ✅ | 9 | 3 | 4(0) | 15.6k | 0 |

### baseline-coding-qwen36 — 9/10, per task

| task | solved | s | turns | tools(err) | tokens | compactions |
|---|---|---|---|---|---|---|
| edit-fix-pagination | ✅ | 42 | 4 | 3(0) | 22.8k | 0 |
| edit-rename-function | ✅ | 51 | 5 | 6(0) | 30.4k | 0 |
| feature-add-command | ✅ | 75 | 6 | 7(0) | 36.8k | 0 |
| feature-stats-module | ✅ | 53 | 6 | 6(0) | 35.3k | 0 |
| fix-empty-cart | ✅ | 39 | 5 | 5(0) | 30.0k | 0 |
| fix-format-duration | ✅ | 51 | 19 | 21(11) | 123.8k | 0 |
| longctx-changelog-version | ❌ `false_done` | 49 | 12 | 15(0) | 75.8k | **2** |
| longctx-wire-modules | ✅ | 25 | 8 | 8(0) | 35.6k | 0 |
| search-negative-amount | ✅ | 50 | 21 | 25(11) | 141.3k | 0 |
| search-retry-default | ✅ | 14 | 14 | 17(4) | 87.4k | 0 |

## Tier-2 — polyglot benchmark, JavaScript track (2026-07-03)

| Suite | Model | Score | Failures | Label |
|---|---|---|---|---|
| polyglot JS (48 tasks, hard subset) | `qwen36-agentic:latest` | **46/48 (95.8%)** | `js-zebra-puzzle`, `js-complex-numbers` (both `false_done` — genuine model limits, zero harness failures) | `polyglot-js-full` |

Aggregates: 3.53M total tokens · median 5 turns/task · 46 tool errors all self-corrected except the two fails.
Standouts: `js-react` (reactive cell system), `js-forth` (19 turns/354k tok, solved), `js-parallel-letter-frequency`
(25 turns, solved), `js-alphametics`, `js-zipper`.

**Method notes (honest):** N=1, temperature 0. The run surfaced and fixed two harness bugs mid-flight —
zombie jest workers surviving task abort (hung 6 tasks to timeout + EPERM-crashed the suite at 21/48; fixed
with `--forceExit --maxWorkers=1` in the shim + non-fatal cleanup) — the 6 affected tasks were re-run under
the fixed shim (5/6 then solved; rows replaced). Early tasks' wall-times include a machine-sleep inflation.
Not leaderboard-comparable (JS-only slice of the 225-task/6-language set); it is OUR fixed external yardstick.

## Findings (what the baselines already tell us)

0. **The agentic tune dominates the coding tune in-harness — measured, not vibes.** Diff
   (`--diff baseline-coding-qwen36 baseline-qwen36-agentic`): 9/10 → **10/10** (changelog task ⬆ FIXED),
   0 regressions, and on the grind-heavy tasks the deltas are dramatic — `search-negative-amount`
   **−17 turns / −119k tokens**, `fix-format-duration` **−15 turns / −102k**, tool errors 26 → 1 across the
   suite. Same base weights, different tune: tool-calling discipline is worth more than raw capability here.
   `qwen36-agentic` is the default model for Cascade work and the reference baseline for eval deltas.

1. **The weak tier's 0/10 was ONE bug — now fixed (ADR-047), with a measured class shift.** llama3.2:3b
   wrote well-formed tool calls into its TEXT (```json fence), never the native channel; the loop saw
   nothing and quit at turn 1. The prose-fallback parser (`prose-fallback-3b` run) changed the failure
   distribution from **10× `no_tool_use` → 1× `no_tool_use` + 4× `invalid_args` + 5× `false_done`** —
   solves stayed 0/10 (a 3B on a 4k window still can't finish these tasks), but the model now runs real
   agent loops (up to 17 turns / 16 tools / 5 compactions). Next rungs, each with its knob: `invalid_args`
   → schema coercion/JSON repair; `false_done` → verify-before-done in the minimal prompt tier.
   *Reliability note:* `longctx-changelog-version` is borderline at N=1 for strong models (observed
   pass/fail flips with identical code; a 2-trial resample passed 2/2) — **gate that task at `--trials 2`.**
   **Rung 2 climbed (ADR-048, `invalid-args-3b`):** alias normalization + directive errors collapsed the
   arg-retry storms (worst task 15→0 tool errors); classes now `false_done` **7** + `invalid_args` 3 +
   `no_tool_use` 0. Solves still 0/10 — the unblocked 3B acts cleanly, then quits without verifying. With
   `false_done` dominant at BOTH curve ends, the next knob is a structural **verification gate** (ADR-049
   candidate), not more parsing. Strong-tier gate: 10/10 → 10/10, exit 0.
   **Rung 3 climbed (ADR-049, `verify-gate-3b` / `verify-gate-check-agentic`):** the loop now refuses a
   terminal answer when files changed but nothing verified them (one nudge, then accept). Agentic:
   **10/10 with the gate FIRING 4×** — the strong model tried to finish unverified on 4 tasks, was nudged,
   verified, still swept. 3B: gate fired 2× (correctly silent when its edits fail — nothing to verify);
   classes `false_done` 7→6. Observation for a classifier refinement: `false_done` without any successful
   edit is really "gave up" — split the class when it starts mattering. Delegation visibility also added:
   `subagentCalls`/`verifyNudges` metrics + the `delegate-scatter` fixture (6 shards vs 8k window; NEUTRAL
   prompt — measures whether delegation happens, never instructs it). Empirical baseline: **zero Subagent
   calls in all eval history** — the next candidate knob is the Subagent tool description.
   **Rung 4 climbed (ADR-050, delegation nudging):** rung 1 (imperative when-to description, tier-sized) →
   **no behaviour change** (0 delegations in 3 samples — descriptions inform, they don't trigger; note this
   is the entire mechanism of a description-only design). Rung 2 (harness-detected reminder at 35% bulk-read pressure) → nudge fired,
   still 0 delegations, **but the model immediately switched from bulk reads to targeted Grep — the optimal
   strategy — tokens 51.7k → 40.7k (−21%)**, solved, gate 11/11. The nudge's true effect is "stop wasting
   the window"; the model may choose a better remedy than delegation. Fixture learning: greppable needles
   can't force delegation — a comprehension-shaped fixture is needed before `subagentCalls` is a target.
   Tier-1 suite is now 11 tasks (delegate-scatter included in the gate baseline).
   **Rung 4b — the three-strike verdict (`delegate-prose-agentic`):** the comprehension-shaped fixture
   (`delegate-prose`: six 337-line prose manuals, uniquely-phrased needles, NO shared token, decoy quotes —
   ungreppable AND unexecutable; 12/12 fixtures sound) STILL produced **0 delegations** — the 35B solved
   both trials by reading through compactions (52–62k tok) with the nudge firing. Conclusion, evidence-based:
   at fixture scale the compactor makes solo-grinding viable, so the model never *needs* delegation, and
   nudging cannot manufacture a need. Delegation's real payoff is at REAL-REPO scale (builder track) —
   **park the delegation push there; keep the metrics; rung 3 (auto-delegation) only if real-scale evidence
   demands it.** The 20B mid-tier tells the same story from below: it fails wire-modules by grinding
   (27 turns/176k tok) where the 35B needs 5 turns — context *strategy*, not window size, is the mid-tier gap.
2. **The compactor works live under pressure.** Both longctx tasks (8k pinned window) ran real compactions;
   `longctx-wire-modules` (needles across 4×~500-line files) SOLVED at 8k. The one 35B failure
   (`longctx-changelog-version`) is `false_done` — it filled `meta.js` but never ran the tests — a
   verify-before-done prompt gap (ADR-037), not a compaction failure.
3. **Self-correction is real and visible.** `fix-format-duration` and `search-negative-amount`: 11 tool
   errors each, still solved — the model grinds through Edit misses/validation errors and recovers.
   Cost: ~120–140k tokens vs ~30k for clean tasks. Tool-error rate is the efficiency metric to watch.
4. **Token floor per task ≈ 3.5k×turns** (system prompt + tool schemas resent every turn) — the
   prompt-tier/caching axis (ADR-037 follow-ups) has a measurable target.

## Infra note (2026-07-03)

During baselining, this box developed a **persistent llama-server load crash (`0xc0000409`, "CUDA error:
shared object initialization failed") for every model that exceeds the 16 GB VRAM and needs CPU offload**
(both 35B blobs — community iq3 AND official — while 3B/8B/20B load fine). Ruled out: residue, launcher,
VRAM, RAM, context size, the specific blob. Worked intermittently earlier the same day → wedged
driver/CUDA state; remedy: reboot, then `ollama` update. The eval stack rides through such crashes
(generate-probe gate + one retry per task + `backend_failure` classification), so infra noise cannot
masquerade as model/harness results.

## How to add the missing rows

```sh
npm run eval -- --model gpt-oss:20b --label baseline-gpt-oss-20b               # mid tier
npm run eval:report -- <label>                                                  # classified scoreboard
```
Then update the curve table above from the scoreboards.

> **Infra resolution (2026-07-03):** a system reboot cleared the 35B load crash — `qwen36-agentic` loaded on
> the first attempt post-restart and swept its suite. Diagnosis confirmed: wedged driver/CUDA state, not a
> model/config problem.

## Rung 5 — ADR-038 wire enforcement, and what an honest window exposed (2026-07-04)

Putting the pinned window ON THE WIRE (`options.num_ctx`, native `/api/chat`) made the 8k longctx fixtures
run in a *real* 8k window for the first time — and the compactor, never before exercised under truth,
failed three different ways. Each failure was traced, fixed, and locked with a replay test
(`compactor.test.ts`); the fix ladder, in incident order:

| gate | build | score | incident exposed |
|---|---|---|---|
| window-enforce-check | enforcement only | 10/12 | Grep `ENOTDIR` on file-as-`path` (fixed) + mask wiped a just-read changelog (6,983→341) |
| window-gate-2 (killed) | + recency shield (keepRecent=5) | — | 5-wide shield held 21k standing over `hard` → Ollama front-truncated silently |
| window-gate-2 | + survival mode at `hard` | 10/12 | weak summary lost the task — *"please share the task you'd like me to work on"* |
| window-gate-3 | + [Original task] preserved | 8/12 | **backend degradation** (empty replies, stalls, one crash) — model reload cleared it |
| window-gate-4 | same, fresh backend | **11/12, 0 regressions, exit 0** | steering nudge could still be summarized away (caught by the unit suite, not the gate) |
| window-gate-5 | + [Latest user instruction] preserved | 9/12 | **overhead never counted**: system+tools+template ≈ 4k of the 8k window — wire showed `inputTokens: 8191/8192, outputTokens: 1` (front-truncation, one token to answer) |
| window-gate-6 | + `overheadTokens` in every threshold; survival ceiling `min(hard, effectiveWindow)` | **11/12, 0 regressions, exit 0** | final push build (one mid-run backend crash-cascade required a model reload + rerun) |

Compactor rules that came out of this (ADR-039 addendum): count-based recency shield; summarize only when
it helps; survival at the ceiling; task + latest-instruction folded verbatim into every summary message;
wire overhead (system + tool schemas + template) counted in every threshold.

**Known weak spot (next rung candidate):** `delegate-scatter` — after survival masking, a weak model sees a
wall of `[output masked — N chars elided]` stubs that name neither the target nor the recovery path, and
answers "I'm ready to help" as if nothing happened. The stub should self-describe (tool + target + how to
recover), and this fixture family is the ADR-050 delegation story anyway.

## Rung 6 — item 4 (arg honesty + edit tolerance) and the summarize-economics fallout (2026-07-04)

Item 4 itself (ADR-048 addendum): JSON repair ladder + `__rawArgs` honest sentinel (4a), whitespace-tolerant
Edit/MultiEdit matching (4b). The 3B probe (`json-repair-3b`) showed NO class flip — its surviving
`invalid_args` are wrong-key schema errors, and its dominant class is **false_done despite the ADR-049
nudge** (the weak tier's next measured rung). The gates then exposed three more small-window defects, each
traced and locked (ADR-039 addendum rules 6+):

- **Summarize economics**: usage hovering just over `auto` paid a 60–120s side-query per turn — two tasks
  timed out SECONDS from success; one swap was net-negative (2,114 → 2,797). → worth-it pre-gate +
  monotonicity guard.
- **Nudge anchoring**: after a survival wipe, the delegation reminder was the last instruction-shaped text,
  and the model ANSWERED it ("Acknowledged — what would you like me to work on?") instead of the task. →
  reminders end by re-anchoring to the original task. `delegate-scatter` passed for the FIRST time ever on
  this fix (then reverted to marginal — its real cure is self-describing stubs).
- **Silent-truncation safety**: cheap layers reclaimed nothing, worth-it blocked summarize, the loop
  proceeded over the ceiling — wire showed `input 8,159 + output 33 = exactly 8,192`. → over the ceiling,
  summarize is mandatory.

**Verification (final build):** marginal trio at N=3 — `longctx-wire-modules` **3/3**, `delegate-prose`
**3/3**, `longctx-changelog-version` 1/3. Full gate `item4-gate-3`: **11/12, all 10 baseline tasks pass, 0
regressions, exit 0.**

**Finding — the honest window costs wall clock:** changelog's successful honest-8k runs take ~570s against
a 600s task budget (baseline's 67s came from the pre-enforcement build silently planning against 32k). Its
failures are now TIME, not confusion (t1 timed out mid-grind, still working correctly). The budget was
calibrated for the cheating era; recalibrating it (or a compaction-latency rung, e.g. cheaper summaries) is
a review-point decision.

## Rung 7 — self-describing stubs + ADR-051 core + instrument hardening (2026-07-05)

- **Self-describing eviction stubs** (delegate-scatter's diagnosis): masked/cleared results now name the
  tool + target + both recovery paths. Measured (clean run): scatter 2/3 at N=3 (from ~never), prose ✅;
  scatter still flips at N=1 — its full cure remains true delegation (ADR-050).
- **ADR-051 core** (verify-gate hardening) shipped INERT: activates only when a check command is declared
  (nothing declares one yet); measurement batched with the next eval per the new method.
- **Instrument**: crash watchdog (model recycle — a crashed runner returns DEGRADED until unload/reload);
  single-runner lock (an orphaned runner survived a TaskStop and double-wrote a 36-row "12-task" gate —
  interleaved rows, 3× turn inflation from GPU contention; locks + PID-liveness now make that impossible);
  changelog budget 600→900s (honest-window physics).
- **Gate**: 10/12; the flagged changelog ❌ is the unchanged known-marginal (≈50% before and after; trace =
  the oversized-first-bite signature, 8,191/8,192 + 1 output token). Root cause queued as the NEXT BATCH:
  ADR-052 window-aware Read bites + overhead-estimate calibration from real `prompt_eval_count`.

## Rung 8 — batch 7: Read bites + check-command wiring + calibration (2026-07-05)

The first batch under the batch-then-eval method (5 changes, unit tests only in between, ONE eval at the
end). New weak tier: **hermes3:8b** (user's 7B rule — the 3B floor never moved; an 8B can).

- **Strong gate (`batch7-gate`): 12/12 — the FIRST PERFECT GATE**, both delegate tasks included. Zero
  regressions, zero added turns on clean tasks; changelog SOLVED by surviving its grind (15 turns,
  5 compactions, 803s under the 900s budget) — Read bites + wire-overhead calibration ended the
  silent-truncation deaths.
- **Weak A/B (`hermes-baseline` → `hermes-batch7`)**: solves flat 1/10 → 1/10, but the classes moved the
  way ADR-051 designed: `false_done` **6 → 2**, `no_tool_use` 2 → 0, → `wrong_code` 0 → 5. The harness
  converted invisible failure (silent "done") into visible failure (ran the declared check, saw red).
  `wrong_code` is the capability wall we deliberately do not fake past.
- Next candidates (review point): delegation for scatter-class tasks (ADR-050 revisit — the strong model
  now delegates; the weak one still needs the story), and whether `wrong_code` at 8B merits a rung
  (e.g. red-test output shaping) or is simply the model's ceiling.

## Rung 9 — skills routing measured (skills-2, 2026-07-07, user-approved run)

**The routing fix worked — user's critique validated end-to-end.** Salvaged pre-fix trace: ZERO Skill
calls (vague descriptions). Post-fix (mandatory rule + trigger-word whenToUse + example call): BOTH
scenarios opened with exactly `Skill architecture` + `Skill design`, and the model COPIED the
architecture checklist into its reply and ticked it while working — the official checklist pattern
functioning verbatim on a local model.

- **builder-shop ✅ 201s** (pre-skills: 146s monolith; skills-with-old-routing: 335s): TEN Writes —
  types, seed data, and 7 components as separate files. The monolith is dead in one-shot builds.
- **builder-shop-iterate ⏱**: died mid-round-2 at 5,231s against a 3,600s budget. Initial read was "a
  hung backend call ignored the abort for ~27 minutes" — **corrected**: this box sleeps/hibernates at
  60 minutes, so the excess wall-clock is most plausibly the machine sleeping mid-run (timers and the
  abort can't fire while suspended; they land on wake). The hang diagnosis is UNPROVEN either way.
  Watchdog-in-core still ships — real mid-stream stalls were observed on other runs — but its stall
  guard is sleep-aware (a timer that fires grossly late re-arms once instead of declaring a stall),
  and approved long runs should hold the machine awake.
- **Planner MISS**: zero AskUserQuestion, zero Subagent{planner} in both scenarios. Diagnosis: the
  plan-first rule is a 3-step COMPOSITE instruction competing with the simple mandate — the mechanical
  rule won, the composite lost (the week's recurring lesson). Candidate fix: the detect→remind idiom —
  harness detects a fresh project + build request + no PLAN.md → injects the exact
  `Subagent {agent: "planner", …}` directive, like the verify gate does.
- Instrument note: the live monitor (tail -F pipeline) produced zero events despite matching content —
  git-bash buffering on an actively-appended NTFS file. Replaced with `scripts/eval/watch.mts`
  (Node-native offset polling, no pipeline); verified against this run's traces — it renders the whole
  story above (skill calls, verify gate, 12 compactions, the build failure) in one screen.

## Rung 10 — plan nudge measured; verdict: orchestrate, don't ask (planner-1, 2026-07-07, user-approved)

**builder-shop ✅ 277s** on qwen36-agentic with the rung-2 nudge live. The mechanism worked end-to-end:
`plan_nudge` fired at turn 2 (writes started, no PLAN.md), the injected directive was read intact — and
the model **deliberately declined it**: "this is a straightforward e-commerce storefront with clear
requirements that I've already understood… I have all the information I need." Zero Subagent calls;
built correctly anyway.

- Class insight: detect→remind converts *forgetting* into compliance (skills, todos, verify) but cannot
  convert *disagreement* — a 36B model treats an advisory as advisory. And on a one-shot scenario its
  judgment was defensible (the plan pays in ITERATE rounds, where compaction erases working memory).
- Fix shipped (ADR-056 rung 3): the builder product now runs the planner as a deterministic pipeline
  stage on every fresh project's first message (server-orchestrated, top-level session, questions reach
  the real user). The nudge stays as the mid-session safety net. Core untouched by policy.
- Next measurement: builder-shop{,-iterate} with the stage live — success = PLAN.md before first build
  write; iterate additionally probes whether later rounds actually re-read the plan (the payoff claim).

### planner-2 (stage live, same day): ✅ 579s — but the PLANNER BUILT

The stage ran end-to-end (plan_nudge correctly silent; first live in-core watchdog recover mid-stage).
PLAN.md content was textbook — all six sections, real interfaces, exact component list, out-of-scope.
**But the planner wrote 6 app files** (types, data, useCart, 3 components) and hit maxTurns=10
mid-build; the builder finished the remaining 4 files and passed. Root cause is OURS: `skills:
architecture` preloaded a BUILD RECIPE with an imperative checklist into the planner's prompt — and
models executing checklists verbatim is precisely the behavior our skills bank on. The skill overrode
the persona ("you never build").

- Fix: preload removed; persona hardened ("you write EXACTLY ONE file: PLAN.md"; skills may be
  consulted but their checklists are the BUILDER's; self-check box "PLAN.md is the ONLY file you
  wrote"). Re-measure before judging the builder's plan-adherence — this run confounds it (the app
  was half-built, so the builder had no reason to read PLAN.md; 0 reads observed).
- If re-measure still shows planner drift: the evidence-driven escalation is path-scoped tool grants
  in core (`Write(PLAN.md)`-style specifiers) — a GENERIC mechanism, not a planner hack.

### planner-3 (persona-hardened, no skill preload): ❌ persona FAILED

The planner received the hardened persona ("you write EXACTLY ONE file: PLAN.md") and the architecture
skill was NOT preloaded (verified in the system prompt), yet its first thought was "build a storefront…
then plan and implement it." It wrote a **295-line App.tsx monolith**, never wrote PLAN.md, and its 5
Bash build-attempts were blocked only by the allowlist. **Verdict: a system-prompt persona cannot hold
a mid model back from building when it has an unrestricted Write + a build request.** Industry check
(the plan modes of hosted app builders): production tools enforce plan-vs-build by REMOVING code-write
capability, never by prompting. → ADR-056 rung 4 (arg-scoped tool grants).

### planner-4 (rung 4, `Write(PLAN.md)`): ✅ 569s — the wall works, BEST build yet

- **Capability wall: complete success.** The planner reached for `Write src/App.tsx` → DENIED with the
  teaching message → **self-corrected to PLAN.md on the FIRST denial** (no flailing, unlike planner-3's
  5 Bash retries), done in 5 turns. Exactly one successful planner write: PLAN.md.
- **Best build to date:** the builder produced 10 clean files (types + data + 7 components) and a
  74-line App.tsx orchestrator. Monolith gone. plan_nudge correctly silent (PLAN.md present).
- **⚠️ Plan CONSUMPTION gap (next rung):** the builder wrote a plan-shaped architecture but **read
  PLAN.md 0 times** — convergent (both agents apply the architecture skill to the same request), not
  consumptive. Harmless one-shot; fatal for ITERATE (the plan exists to survive compaction across
  rounds). Closing it needs the plan IN the builder's context, not just on disk — and the iterate
  scenario to prove where it pays. Candidate: the stage injects PLAN.md (short, <page) into the
  builder's first message; measure on builder-shop-iterate (needs runner keep-awake for the ~90-min run
  vs the 60-min sleep).

### planner-5→8: closing the consumption loop (ADR-056 rung 5, pinned context)

Fix chosen: pin PLAN.md into the builder's SYSTEM PROMPT, re-read fresh each turn (survives compaction,
no reliance on the model Reading). Reaching a proven mechanism took four runs, each exposing a defect
units couldn't:

- **planner-5** ⏱ (1800s, hit ceiling): the pin WORKS (plan in the builder's prompt) but the full 6.4KB
  plan was a ~1600 tok/turn tax that pushed the build over the compaction threshold — 0→3 compactions →
  a re-read/re-edit cascade (11→26 turns). The plan meant to survive compaction was *causing* it.
  → Fix: terse planner (~1.5KB dense skeleton, no prose) + a core `PIN_CAP_CHARS=2500` backstop.
- **planner-6** ❌ (no PLAN.md): the Write(PLAN.md) grant reliably STOPS building, but whether the planner
  then WRITES the plan vs. SPEAKS it in chat is non-deterministic — here it dumped the plan into its
  final message and never wrote the file, so the pin had nothing to inject. → Fix: `ensurePlanPersisted`
  captures the planner's final message as PLAN.md when no file was written (belt = grant, suspenders =
  capture).
- **planner-7** — inconclusive: Ollama HTTP 500 (llama-server crash) killed the stage after 3 watchdog
  retries; the builder degraded gracefully and built without a plan (the designed fallback). Infra, not
  code. Ollama recovered on its own.
- **planner-8** ✅ (462s — fastest yet): ALL fixes hold together. The planner spoke the plan (3 code-write
  denials, no Write) and `ensurePlanPersisted` captured it → clean 1.5KB PLAN.md (`# Cascade Shop —
  Plan`, six terse sections). Pinned in the builder prompt (16.6KB, not 21.5KB); **0 compactions**, 11
  turns, 8 clean files matching the plan. The one-shot mechanism is PROVEN.

Runner keep-awake (`scripts/eval/keepAwake.mts`, SetThreadExecutionState) now holds the box awake so the
iterate durability run survives the 60-min sleep.

### The hardware envelope (iterate-3→6 + probes): the 36B Q4_K_M is a 24GB model on a 16GB card

The tuning arc that followed iterate-2's crashes, one lever per run:

| run | config | stability | speed | lesson |
|---|---|---|---|---|
| iterate-2 | defaults (batch 512) | ❌ 6 crashes | mixed | living on the allocation knife-edge |
| iterate-3 | num_gpu=36 | ✅ | ❌ 5 tok/s | CPU-streamed MoE experts = wrong knob |
| iterate-4 | batch 256 | ✅ | ❌ prefill-bound | agentic turns are PREFILL-heavy; batch is the prefill knob |
| probes | batch 384 vs 512 | — | 651 vs 133 tok/s | **512's buffers SPILL to shared memory** (the silent 5×) |
| iterate-5 | batch 384 @16k | ✅ 0 crashes/90min | R1=54min | correct-under-torture; 21 compactions survived; the pin held |
| iterate-6 | batch 384 @32k | ❌ crashes return | 0.6 tok/s | 32k KV blows the envelope outright |
| probes | 20k/24k | ❌ crash / 9GB spill | — | the cliff sits JUST above 16k |

Root fact (visible in `ollama ps` only under load): the Q4_K_M 36B is **24GB total — 9GB has been on
CPU all along**. The card's honest envelope for it: **num_ctx 16384 + num_batch 384**, and nothing more.
No code fixes physics; what code COULD fix, this arc fixed and tested:

- retry budget resets when `recover()` verifies the backend healthy (capped ×3) — rounds now bridge
  crash+reload instead of dying in a 15s retry window;
- the compactor's summarize call is GUARDED (`completeWithRecovery`) — an unguarded raw complete() was
  how a 300s backend wedge killed iterate-5's R3/R4 before the main (guarded) call was even made;
- summarizer still unreachable ⇒ compaction degrades to a task-preserving DROP (`kind: 'dropped'`) —
  compaction can never kill a round again;
- `ProviderConfig.options` passthrough (adapter-level) + `--gpu-layers/--ollama-options/--context-window`
  ops knobs on the bench.

**The resident alternative (probed):** `qwen36-fast` — the SAME 36B at IQ4_XS — is 15GB, loads FULLY
RESIDENT at 16k/384 (zero spill), 555 tok/s prefill, GPU-speed decode. On this card it is the
configuration the hardware wants; Q4_K_M remains the quality reference for short runs.

### iterate-2 (6 rounds, pinned 16k window): ❌ build — but durability PROVEN, failure is INFRA

Keep-awake worked (the run went the full 2445s / 41 min without sleeping). The check failed ("built
bundle missing 'Cascade Shop'"), but forensics show the cause is **backend instability, not the plan
mechanism**: 6× `ollama HTTP 500 (llama-server crash)` across the run, one needing 5 watchdog retries.
Round 1 built the 8 component files but llama-server crashed BEFORE it wrote App.tsx (the view-switcher
that sets `shopName`), so the app was never wired up — App.tsx stayed the template default. Rounds 2, 3,
6 did nothing (backend down when they started). Same failure class as planner-7.

**The durability claim rung 5 exists to prove is nonetheless CONFIRMED:** in round 1 the pinned plan
survived all **6 compactions** — present and still terse in the 15th (last) model_request, identical to
the 1st. The plan-in-system-prompt genuinely outlives what compaction does to message history. That is
the core positive result; a clean full 6-round consistency demo is blocked only by the 36B model
crashing llama-server under sustained load (an infra/hardware issue, orthogonal to Cascade). Follow-up:
either stabilise the backend (Ollama num_ctx/flash-attn tuning, model reload) or run the consistency
demo on a more stable model.
