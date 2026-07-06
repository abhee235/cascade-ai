# ADR-056 — Named agents: file-defined personas for delegation (planner first)

> **Status:** accepted 2026-07-06 (user: "agents are like skills but used differently — e.g. the builder
> should always PLAN first via a planner.md, maybe ask the user about db/auth/backend"). Implementing.

## Context

File-defined agents (a directory of `agents/*.md` definitions) are the established
delegation twin of skills: frontmatter (`agentType`, `whenToUse`, `tools` allowlist, `model`,
`maxTurns`, `skills` to preload…) + a markdown BODY that becomes the spawned agent's OWN system prompt.
**Skills change how the current agent works; agents change WHO does the work** — a fresh context, its
own persona and tool permissions, only the final report returns. Cascade has the mechanics (Subagent →
nested loop) but only anonymous errand-runners: no personas, no per-agent tool policy, nothing a user
can define.

## Decision

Same engine pattern as ADR-055, reusing its loader conventions:

1. **`AgentDef`** — frontmatter: `name`, `description` (the when-to-use line advertised to the main
   model), `tools` (allowlist for the child registry), `maxTurns`, `skills` (names whose BODIES are
   preloaded into the child's system prompt — born knowing the recipes), `interactive` (reserved, v1.1);
   body = the child's system prompt (REPLACES the parent's extraInstructions — a planner must not
   inherit builder-behavior).
2. **Loading & shadowing** — `agentDirs` session option, base dirs first (server-owned, immutable,
   outside the Read jail) then project `.cascade/agents/` (user's own; shadow by name).
3. **Spawning** — Subagent tool gains `agent?: string`. The loop resolves the def: child gets the def's
   system prompt, a registry filtered to its allowlist, its maxTurns, preloaded skills. Unknown name →
   error listing available agents (self-correction). The system prompt gains an Agents index line-per-
   agent (like the skills index) so the main model knows who it can delegate to.
4. **The builder's planner flow (first pack + measured scenario):** BUILDER_BEHAVIOR: for a NEW app or
   major feature — (a) the MAIN agent asks up to 3 clarifying questions (AskUserQuestion: persistence?
   auth? key views?), (b) spawns `planner` with the request + answers, (c) planner (tools: Read, Glob,
   Grep, Skill, Write; skills: architecture preloaded) writes `PLAN.md` — pages, data model, components,
   out-of-scope — and reports a summary, (d) the builder implements AGAINST the plan; later feature
   rounds re-read it for consistency.

## Deliberate v1 choices

- **Children still cannot ask the user.** The user's clarify-step runs in the MAIN loop (it owns the
  question channel). v1.1 design noted: session.submit becomes a merged stream (loop events + a
  side-channel) so `interactive: true` agents can surface question cards from inside a spawn — until
  then the flag is parsed but inert.
- No per-agent model/effort overrides (single local model today), no plugin agents, no agent memory.

## Verification

Unit: def loader (frontmatter, shadowing); named spawn through the real loop (child system prompt = def
body, tool allowlist enforced, skills preloaded); unknown-name error. Bench: a fresh-project shop run —
success = trace shows questions → planner spawn → PLAN.md written → build references it.
