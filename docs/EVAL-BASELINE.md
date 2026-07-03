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
| mid (8–20B) | — | *not yet run* | | `hermes3:8b` / `gpt-oss:20b` verified loadable |
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
