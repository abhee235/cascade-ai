# PLAN — Harness Eval: measure it, diagnose it, tweak the right knob

> **Why this exists.** We now have three big harness levers — ADR-037 (prompt tiers), ADR-038 (model profile),
> ADR-039 (layered compactor) — and zero measurement. Research consensus (2026): the harness is worth 10–20
> points on *identical* model weights. This plan builds the instrument that turns "I believe it helps" into
> "here is the delta," and — more importantly — tells us **which subsystem to tweak** when a task fails.
>
> **The method (never deviate):** hold the model fixed → change ONE harness thing → re-run the suite → read the
> delta. And report every result as a **curve across model sizes** (7b/14b/32b): the lift at the weak end is
> Cascade's whole value proposition, made empirical.

## Architecture — three components

```
eval/tasks/*            scripts/eval/run.ts              scripts/eval/report.ts
┌──────────────┐   ┌───────────────────────────────┐   ┌────────────────────────────┐
│ TASK FIXTURES │ → │ RUNNER: headless session per   │ → │ ANALYZER: score + classify │
│ repo/ + task  │   │ task (sandboxed, auto-allow),  │   │ each failure + scoreboard  │
│ + check cmd   │   │ writes results + full traces   │   │ + diff two runs            │
└──────────────┘   └───────────────────────────────┘   └────────────────────────────┘
                          each task ⇒ results.jsonl row + trace.jsonl (ADR-023)
```

The tracer (ADR-023) is the backbone: the analyzer computes almost every metric **from the trace alone**,
so most of this plan needs no core changes.

## The diagnosis layer — failure class → which knob to tweak

This table is the point of the whole system. The analyzer auto-classifies every failed task from trace
signatures; the class routes you to the subsystem:

| Trace signature | Class | Tweak this |
|---|---|---|
| Task needs edits, but terminal answer with **0 tool calls** (or tool call visible in prose text) | `no_tool_use` | provider parse strategy (prose fallback / JSON repair), prompt tier (ADR-037) |
| `tool_result ok:false` matching `Invalid input` ≥2× for the same tool | `invalid_args` | Zod coercion in schemas, JSON repair |
| `No such tool:` in results | `bad_tool_name` | fuzzy-name suggestion in runTool |
| Edit errors (`not been read yet` / `old_string … not found`) recurring | `edit_mismatch` | Edit guidance in prompt, read-before-edit flow (ADR-032) |
| `turn_done` at maxTurns with unfinished todos | `loop_stall` | todo reminder cadence (ADR-034), maxTurns budget, Ralph/fresh-context |
| ≥3 `compaction` events in one run, or overflow retries | `context_thrash` | plan thresholds (ADR-039), keepRecent, **num_ctx allocation (ADR-038!)** |
| Edits made, `check` still fails | `wrong_code` | verify-before-done prompt (ADR-037), model tier — maybe not a harness bug |
| Model says "done" but check fails, no test run in trace | `false_done` | verify-before-done prompt section |

Rule of thumb: `no_tool_use` + `invalid_args` dominate ⇒ fix the **provider/parse** axis first;
`context_thrash` dominates ⇒ fix **windows/compaction**; `loop_stall` ⇒ fix **executive function**.

## Metrics per task (one JSON row)

- **Primary:** `solved` (check command exit 0), across N=2 trials (report solved@1, solved@2).
- **Secondary (harness quality, from the trace):** turns, wall ms, prompt+output tokens (E1), tool calls
  (ok/error counts), tool-error rate, compactions fired (by kind), recovery retries, failure class.

Secondary metrics matter even when solved=true: a change that keeps solved rate but −30% tokens or −2 turns
is a real win.

## Task fixture format

```
eval/tasks/<id>/
  task.yaml     # prompt, check (shell cmd), budgets {maxTurns, timeoutMs}, tags [edit|feature|fix|search|longctx]
  repo/         # seed project (small!), copied to a temp dir per run
```

Starter suite = **10 tasks**, 2 per category: single-file edit · multi-file feature · fix-a-failing-test ·
search-heavy ("find where X happens and change it") · **long-context** (forces compaction — big files to read
before the edit matters). Categories map to the failure classes they're most likely to trigger.

Runs land in `eval/runs/<timestamp>-<label>/` (gitignored): `results.jsonl`, `scoreboard.md`, `traces/<task>.jsonl`.

## Phases

| | Phase | Deliverable | Verify |
|---|---|---|---|
| E1 ✅ | **Instrument** | **DONE (ADR-040):** usage (Ollama `eval_count`/`prompt_eval_count`, OpenAI `usage`) → `done` StreamEvent → `model_response.usage` trace; `compaction {kind, tokensBefore/After, forced}` trace events at both sites; `temperature` passthrough | ✅ `usageTrace.test.ts` drives the real loop (3 tests) |
| E2 ✅ | **Fixtures** | **DONE:** `eval/tasks/` — 10 dependency-free Node tasks (2× edit/feature/fix/search/longctx), `task.json` spec (JSON not YAML — zero deps) with `protected` paths + `session` overrides; longctx bulk via committed `_generate-longctx.mjs`; spec in `eval/README.md` | ✅ `node eval/verify-fixtures.mjs`: 10/10 seed-fails + solution-passes |
| E3 | **Runner** | `bun scripts/eval/run.ts --model X --label Y [--tasks a,b]` — temp-copy fixture, headless session (bypass permissions, sandbox), run check, write row + trace | run 2 tasks against real Ollama end-to-end |
| E4 | **Analyzer** | `report.ts`: scoreboard + failure classification + `--diff runA runB` (per-task regressions highlighted) | classifier unit-tested on synthetic traces of each failure class |
| E5 | **Baseline + matrix** | run suite × {qwen 7b, 14b, 32b}; commit `docs/EVAL-BASELINE.md`; from now on **every harness ADR gets a before/after eval row** | baseline table exists; ADR template gains an "eval delta" line |

Order matters: E1 first (cheap, benefits everything), E4's classifier is testable without any model.

## Ground rules

- **Determinism:** temperature 0 in eval runs (needs `samplingParams` passthrough in the provider — small E1
  addition), N=2 trials, medians. Accept residual flake; the diff view flags per-task flips.
- **Budgets:** every task has maxTurns + timeout; a hung task is a `loop_stall` data point, not a hung suite.
- **Cost honesty:** 10 tasks × 2 trials × 1 local model ≈ 30–60 min on this hardware. That's a nightly/
  pre-merge suite, not a per-save one. Keep the suite ≤10 tasks; resist growth.
- **No reward hacking:** check commands verify *behaviour* (run the tests), never string-match the diff —
  the 2025 SWE-bench audit found ~20% of "solved" labels were semantically wrong; don't recreate that.

## Tier 2 — external benchmarks (later, after E5)

- **The polyglot benchmark** first (edit-format reliability; fixed methodology, not gameable) via a thin adapter over
  the headless core; then a **Terminal-Bench** subset; **BFCL** if we want a pure tool-calling number.
- These give comparability to the outside world; the Tier-1 suite remains the daily instrument.

## Non-goals (now)

Leaderboard chasing · >10-task suites · LLM-judge scoring (behavioural checks only) · CI-hosted GPU runs.
