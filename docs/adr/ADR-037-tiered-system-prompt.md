# ADR-037 — Tier-aware, sectioned system prompt (CORE-PARITY A6; consumes ADR-038/039 window tiers)

> **Status:** accepted; **implemented** — tier-aware system prompt + window tiers + the coding-qwen36 window
> fix + **per-tool prompt enrichment** (Bash/Write/Edit/Read/Grep/Glob to production-grade content; TodoWrite/Memory/
> MemorySearch/Subagent were already rich) + a **subagent-specific prompt** (G8). Deferred: git-status/dir-tree
> context injection (G7), and wiring the real ADR-038 profile (num_ctx auto-detection).

## Context

An audit of both prompt surfaces (see `docs/learnings/` and the CORE-PARITY A6 row) found the widest gap in the
whole project:

- **Mature frontier-model agents** carry a **~15-section** default system prompt: identity, system rules,
  task guidance (read-before-modify, verify-before-done, report-faithfully, minimal-complexity), acting with
  care, tool usage, tone and style, output efficiency, env, memory, MCP, scratchpad, a note that tool results
  may be cleared, … — plus **~35 per-tool prompt** files.
- **Cascade** had a **single ~8-line string**: identity + env + a couple of guidance lines. No behavioural
  guidance at all.

For a **weak local model** this is the highest-leverage fix we have: a frontier model *infers* "read before you
edit", "verify before you claim done", "don't over-engineer"; a weak model does **not** — we watched
qwen36-agentic report *"Done! created plan2.txt"* when it hadn't. The behavioural sections are precisely the
scaffolding that keeps a weak model honest.

But we **cannot adopt a frontier-sized prompt as-is.** ADR-038's finding: on a 32k window such a preamble eats
**30–50% before turn 1**. Those agents are mono-target (they assume a 200k window); Cascade is multi-window (32k
Qwen → 128k coding-qwen36 → 200k cloud models). So the prompt must **adapt to the window**, like the compactor does.

**A load-bearing bug found while writing this ADR.** `contextWindowForModel` matched `coding-qwen36` against the
generic `…qwen36 → 32_768` rule — but coding-qwen36's Modelfile pins **`num_ctx 131072` (128k)**. So the
compactor was sizing a 128k model as 32k, compacting at ~22k and **discarding ~73k of usable context every
session**. (Two variants of one base differ: qwen36-agentic pins 32k, coding-qwen36 pins 128k — the map can't
see that; the real fix is ADR-038 `/api/show` num_ctx discovery, deferred.)

## Decision

### 1. Window tiers — one coarse switch, shared ([llm/contextWindows.ts])

```ts
type WindowTier = 'minimal' | 'lean' | 'full'
windowTier(w) = w < 24_000 ? 'minimal' : w < 96_000 ? 'lean' : 'full'
```

- `minimal` (<24k): a rich preamble would eat the window → a tight core-rules digest + env only.
- `lean` (32k/64k): the load-bearing rules, condensed (first sentence of each; drop examples + `Acting with care`).
- `full` (128k/200k/1M): the whole behavioural prompt.

**128k lands in `full`** — its own band, distinct from the 32k `lean`. (64k also `lean`; the 96k boundary is a
tunable default.) The tier is derived once and **recorded on the `CompactionPlan`** so the compactor and the
prompt read the *same* number — and the fix makes coding-qwen36 resolve to 128k → `full`.

### 2. The system prompt is now composable sections ([agent/systemPrompt.ts])

Each section is a function; `buildSystemPrompt({ tier })` selects by tier. Follows the common section layout,
weak-model-tuned (condensed, not verbatim):

| Section | Gap | Tiers | Why a weak model needs it |
|---|---|---|---|
| `# Doing tasks` | **G1** | full+lean | read-before-edit, **verify-before-done**, **report-faithfully**, minimal-complexity, diagnose-don't-flail — the false-completion cure |
| `# Using your tools` | G2 | full+lean | prefer Read/Edit/Grep over Bash; TodoWrite planning; parallel reads |
| `# Tone and style` | G4 | all | concise, `file_path:line_number`, no emoji, no colon-before-tool |
| `# Acting with care` | G5 | full only | confirm risky/irreversible ops; no destructive shortcuts |
| results-get-cleared | **G10** | all | pairs with ADR-039 — tells the model its observations are transient, so it records key facts |
| system-reminder framing | G9 | all | we inject `<system-reminder>` (ADR-034); now the model knows what they are |
| `# Environment` | — | all | cwd/OS/date + the ADR-033 relative-path rule |

The full prompt is ~1k tokens (<1% of 128k); the lean ~400 (~1.2% of 32k) — far under the ~3–5k of frontier-model
prompts, by design.
Threaded `LoopDeps → buildSystemPrompt({ tier: deps.compact?.plan.tier ?? 'full' })`.

## Consequences

- **Weak models get the behavioural scaffolding** they can't infer — most importantly *verify before done* +
  *report faithfully*, aimed straight at the false-completion failure we observed.
- **Adaptive, not mono-target** — a step beyond mono-target prompts: the same prompt engine serves a 32k Qwen
  (lean) and a 200k cloud model (full). A mono-target prompt would over-spend a 32k window; we don't.
- **coding-qwen36 now sized correctly** (128k, compacts ≈95k) instead of throwing away ¾ of its window.
- **Shared tier** keeps prompt richness and compaction thresholds from drifting apart.

## Verification

- Unit: `windowTier` bands (8k→minimal, 32k/64k→lean, 128k/200k→full, boundaries); `resolveCompactionPlan
  ('coding-qwen36')` → window 131072, tier `full`, `auto > 90k` (proves the fix) while `qwen36-agentic` stays
  32k; each tier selects/omits the right sections (`full` has `Acting with care`, `lean` doesn't, `minimal` is
  the digest). **All green + full suite.**
- (Follow-up) live on coding-qwen36: confirm the `# Doing tasks` "verify before done / report faithfully"
  section curbs the false-completion behaviour on a task designed to tempt it.

## Per-tool prompts (G3) — done, and tier-sized like the system prompt

Cascade keeps tool prompts **inline in each tool's `description`** (its convention; the alternative is ~35
separate per-tool prompt files). Crucially, descriptions are advertised on **every request** — so the same tier strategy
applies to them: `Tool.description` may now be `string | ((tier: WindowTier) => string)`, resolved at the
single advertisement point (`toolRegistry.descriptionOf` / `schemas(tier)`); the loop passes one `tier`
(explicit `deps.tier` → compaction plan's tier → 'full'), and **subagents inherit the parent's tier** (they
run without compact deps). Plain-string descriptions (all MCP tools) pass through unchanged.

**Which descriptions to tier is a per-tool decision on two axes** — bulk (is there enough to save?) ×
load-bearing-ness (does cutting it cause failures?). *Advisory* guidance (when-to-use, workflow tips)
compresses; *load-bearing rules* are never cut at any tier: a dropped Edit rule causes failed-edit retry
loops that cost far more tokens than the words saved — on a small window those rules matter MORE, not less.
(The system prompt already follows this: `minimal`'s Core-rules digest keeps every load-bearing rule in
compressed form; only elaboration and the advisory `Acting with care` drop out.)

| Tool | Decision | Why |
|---|---|---|
| **Bash** | **tiered** (full/lean/minimal) | biggest description; protocol is compressible — every git-safety rule survives, one line each |
| **TodoWrite** | **tiered** (full/condensed) | when-to-use is advisory; ALL FOUR rules kept at every tier (tool result + reminder re-teach them anyway) |
| **Edit / Read / Write** | **flat — deliberate** | wholly load-bearing (exact-match, uniqueness, `N→`-prefix, overwrites-everything); compact already |
| Grep / Glob / Memory / MemorySearch / Subagent | flat | already compact (~30–70 words); nothing worth saving |

Enriched to production-grade, weak-model-tuned content:
- **Bash** — the biggest gap (was 1 line vs ~370 in mature agents): tool-preference (prefer Read/Edit/Write/Glob/Grep),
  git-safety protocol (new commit not `--amend`, no `--no-verify`/destructive without asking, stage by name),
  quoting, no-interactive, parallel-vs-`&&`, cwd/shell-state notes.
- **Write** (overwrites entirely → prefer Edit, Read-first), **Edit** (Read-first, exact match incl.
  whitespace + unique, don't include the `N→` line-number prefix), **Read** (line-number prefix guidance),
  **Grep** (contents-by-regex, vs Glob, narrowing), **Glob** (files-by-name, vs Grep).
- TodoWrite/Memory/MemorySearch/Subagent already carried rich descriptions.

## Follow-ups (deferred, named — not silently cut)

- **Context injection (G7):** git status + directory tree as a `full`-tier section.
- **ADR-038 num_ctx auto-detection:** retires the static window map (the root cause of the coding-qwen36 bug).
- The remaining per-tool prompts of mature agents are for tools/features Cascade doesn't have
  (Task*/Team*/Web*/LSP/Notebook) or specialized services (session titles, auto-maintained docs, proactive
  mode) — **N/A** until those features exist.

[llm/contextWindows.ts]: ../../packages/core/src/llm/contextWindows.ts
[agent/systemPrompt.ts]: ../../packages/core/src/agent/systemPrompt.ts
