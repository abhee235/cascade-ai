# ADR-046 — Project context gathering: directory tree + git status (CORE-PARITY A6)

> **Status:** accepted; **implemented + tested.**

## Context

A strong model discovers a project's shape on its own; a **weak** one burns turns on `ls`/Glob and — worse —
**hallucinates paths** it never verified, one of the top weak-model failure modes. Mature coding agents close
this by prepending a memoized system context to each conversation: a **git status** snapshot (branch, `status
--short` truncated at 2 k, `log --oneline -n5`, explicitly labelled as a snapshot that won't update) plus the
project's own **instruction file**.

Cascade already injects its own instruction file (`CASCADE.md`) via `loadMemory` (ADR-015). The genuinely
missing pieces were the **directory tree** and the **git status** — and cross-tool recognition of **other
agents' instruction files** (e.g. `AGENTS.md`) for real repos that don't use `CASCADE.md`.

## Decision

New pure module [agent/projectContext.ts] with `gatherProjectContext({ cwd, tier })`:

- **Directory tree** — a bounded, indented tree relative to the project root (dirs first, then alphabetical),
  skipping dependency/build dirs (`node_modules`, `dist`, `.git`, …) and hidden directories, keeping hidden
  *files* (`.gitignore`, `.env.example`). **Tier-sized** caps (ADR-037): `full` 200 entries/depth 4, `lean`
  100/3, `minimal` 40/2 — even the smallest window gets a tree, because path-awareness is exactly what the
  weakest models need most. Over the cap → a `… (more files omitted — use Glob …)` marker.
- **Git status** — only when `cwd` is a repo (`.git` exists; most scaffolded web projects aren't → skipped).
  Branch + `status --short` (truncated at 2 k) + `log --oneline -n5`, labelled a start-of-session snapshot.
  Shells out with a 5 s timeout; any failure omits the block (best-effort).
- **Cross-tool instruction-file interop** ([memory/memoryStore.ts]) — `memoryFiles` now also reads other
  agents' instruction files (e.g. `AGENTS.md`) at each directory level, at **lower** priority than the
  Cascade-native `CASCADE.md`, so real repos / cross-tool projects are honoured without duplicating instructions.

**Wiring (the cache boundary):** gathered **once** per session by `ensureProjectContext()` (mirrors
`ensureDetectedPlan`, ADR-038), *after* window detection so it uses the real tier, cached, and threaded through
`runAgentLoop → buildSystemPrompt` as `projectContext`. It's appended to the **system prompt** (outside the
compactable history, so the layout is always available and never summarized away) and given to the **main agent
only** — a subagent runs a focused, delegated task, not the whole tree (the common practice of stripping git
status from subagents).

## Consequences

- The model starts every session already knowing the file layout → fewer wasted `ls`/Glob turns and far less
  path hallucination — a direct weak-model win. On a git repo it also sees the branch and what's dirty.
- Bounded and tier-sized, so it never dominates a small window; best-effort, so a non-repo or a git hiccup just
  omits a block rather than failing the turn.
- Gathered once and cached — no per-turn filesystem/git cost.

## Verification

Headless ([projectContext.test.ts], 8/8): the tree lists `App.tsx`/`package.json` and skips
`node_modules`/`dist`; the minimal tier honours the depth-2 cap (hides a depth-3 file that `full` shows) and
marks truncation past 40 entries; a non-repo omits the git block while a real temp repo shows branch + `seed
commit` + the untracked file; `buildSystemPrompt` injects the block for the main agent and omits it for a
subagent; `memoryFiles` includes the other-agent instruction files + `CASCADE.md`. Full suite 190 green. Live-verified
in the web builder (the model receives the tree + git snapshot in its system prompt).

## Follow-ups

- Live directory-tree refresh after the model creates files (currently a start-of-session snapshot, like the
  usual git-status snapshot — the model knows about files it wrote itself).
- Respect `.gitignore` when walking (currently a fixed skip-list).

[agent/projectContext.ts]: ../../packages/core/src/agent/projectContext.ts
[memory/memoryStore.ts]: ../../packages/core/src/memory/memoryStore.ts
[projectContext.test.ts]: ../../packages/core/test/projectContext.test.ts
