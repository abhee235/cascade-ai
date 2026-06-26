# ADR-017 — Subagents: delegation via a nested, context-isolated loop

**Status:** Accepted (Phase 12).

## Context
Some subtasks are **separable and context-heavy** — "search the whole codebase for X", "investigate this
independent question". Doing them inline floods the main agent's context with 20 file reads it doesn't need
afterward. Delegation fixes this: hand the subtask to a **fresh agent with its own context window**, let it
work, and take back **only the conclusion**.

## Decision
A `Subagent` tool (orchestrator–worker, **one-way**: parent dispatches → child reports back):
- **Input** `{ description, prompt, subagent_type? }` — `prompt` must be fully self-contained (the child
  starts blank and can't be talked to mid-run). `subagent_type`: `general-purpose` (full tools) or `explore`
  (read-only).
- **Mechanism (no import cycle):** the loop injects `ctx.spawnSubagent` (a closure). The tool calls it; the
  closure runs a **nested `runAgentLoop`** with:
  - its **own messages** `[{user: prompt}]` (isolation — separate array from the parent),
  - a **filtered tool subset** via `registryOf`: always **minus `Subagent`** (no recursion), and for
    `explore`, only `Read/Glob/Grep/MemorySearch`,
  - the same provider/model/permission/tracer, `maxTurns: 8`, `depth + 1`.
- **Return:** only the child's **final assistant text** becomes the single `tool_result`. Its intermediate
  steps are consumed inside the closure (not yielded) → the UI shows one `Subagent` card; the full nested
  activity is in the JSONL trace.

## Edge cases (how we rule them out)
- **Infinite recursion** → `MAX_SUBAGENT_DEPTH (2)` gate (no `spawnSubagent` at/over the cap) **and** the
  child registry never contains `Subagent` (belt + suspenders).
- **Permissions mid-delegation** → `explore` is read-only (no prompts); `general-purpose` shares the parent's
  permission controller (writes still gated).
- **Abort** → the child loop is passed the parent's `signal`.
- **Child failure** → the tool returns an error `tool_result` ("Subagent failed: …"), the parent adapts — no
  crash.
- **Cost** → a subagent is a full nested loop (many model calls); the description warns it's for separable,
  context-heavy work only.

## Consequences
- Multi-step agents **scale**: the parent's context stays lean (summaries, not transcripts), so it can run
  longer before compaction.
- Same `runAgentLoop` powers parent and child — delegation is recursion at the *function* level.
- Defer: background/async agents, worktree/remote isolation, agent teams (collaborative), nested-activity UI,
  per-agent MCP, custom agent definitions from a directory.

## Prior art
The common delegation tool takes `{description, prompt, subagent_type}` and runs a nested agent (its own
assembled tool pool for the worker, allowed tools → session permission rules), with recursion blocked at
call-time. Built-in agent types (`general-purpose`, `explore`, `plan`, …) = system prompt + tool subset.
We distill to a depth-capped nested loop with a read-only/full subset.
