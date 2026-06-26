# System Design: Resilience + Subagents (Phase 12)

Intuition, algorithm, and edge cases for the capstone — grounded in production retry and delegation
practice + 2026 research.

---

## Part 1 — Resilience (`withRecovery`)

### Intuition
The model call is the one step that fails for reasons outside our control: the network blips, the provider is
overloaded, the context overflows. A naive loop crashes the whole turn. Resilience = **wrap the model call so
transient failures are retried sensibly, recoverable ones are recovered, and fatal ones fail fast with a clear
message** — never crash, never hammer a dead endpoint.

### Error taxonomy (the crux — what to retry vs not)
| Class | Examples | Action |
|---|---|---|
| **Transient** | network (ECONNRESET/ECONNREFUSED/timeout), 408/409, 429, 5xx, 529 "overloaded" | **retry** w/ backoff |
| **Recoverable** | context overflow ("input + max_tokens > limit"), 401 (refresh auth) | **fix then retry** (compact / re-auth) |
| **Fatal** | 400 bad request, 403, malformed, **user abort** | **fail fast** (no retry) |

A production retry layer's should-retry check is exactly this table; non-retryable errors raise a
distinct cannot-retry error.

### Backoff (production-grade numbers)
`delay = min(BASE(500ms) * 2^(attempt-1), 32_000) + jitter(random*0.25*base)`; **honor `retry-after` header**
if present (server knows best). Max retries = 10; 529s counted separately (max 3 → then
**fallback model** or surface "overloaded"). **Jitter** de-synchronizes clients (avoids thundering herd).
Research adds: only retry 429/5xx/529; honor `Retry-After`; circuit-break per provider+model.

### Recovery paths
- **Context overflow** → this is where Phase 11 pays off: **compact, then retry** (production agents adjust
  `max_tokens` and/or compact on a context-window-exceeded error).
- **Auth 401/403** → refresh token, retry. **Fallback model** → on repeated overload, switch model.
- **Abort** → checked every attempt and during the sleep; throws immediately (never swallow).

### Edge cases to rule out
1. Retrying a deterministic **400** forever (it'll never succeed) → fatal, fail fast.
2. **Abort during backoff sleep** → must wake and stop, not finish the wait.
3. **maxRetries exhausted** → surface a clear message, don't throw raw.
4. **Background vs foreground** amplification (background request sources should bail on 529 to avoid
   gateway pileup).
5. **Overflow retry loop** that never shrinks → floor (e.g. a 3,000-token output floor); if can't fit, fail.
6. Retry must **re-evaluate** the request (re-compact) each attempt, not resend the too-big one.

### Cascade design (Ollama-native, simpler)
`llm/resilience.ts → withRecovery(fn, opts)`: classify error → if transient, backoff(+jitter, cap, honor
retry-after) up to `maxRetries` (~4); if **overflow**, run `compactIfNeeded` then retry; if **abort**, rethrow;
else fatal. Optional `fallbackModel`. Wrap the `provider.stream`/`complete` call in the loop. Defer: per-model
circuit breakers, persistent/unattended mode, fast-mode.

---

## Part 2 — Subagents (how the main agent delegates)

### Intuition: delegation = context isolation
A subagent is **a fresh agent loop with its OWN context window**, given one task, that runs to completion and
**returns only its final answer** to the parent. The win is **context isolation**: the noisy exploration
(20 file reads, 10 greps) happens in the *child's* context and never bloats the *parent's*. The parent gets a
clean summary. It's the **orchestrator–worker** pattern, **one-way**: parent dispatches → child reports back
(no back-and-forth). [published multi-agent research]

### How delegation works (the mechanics)
1. **The tool the model calls** — a delegation tool, input:
   `{ description (3-5 words), prompt (the task), subagent_type? }` (richer versions also take model,
   run_in_background). The model decides to delegate by calling this tool, just like any other.
2. **Spawn a nested loop** — the tool builds a **new conversation** seeded with `[{role:user, content:
   prompt}]`, a **subagent system prompt** (its identity/role), a **tool subset**, and its **own model**.
3. **Run to completion** — it's `runAgentLoop` again (recursion at the *function* level), in **isolation**:
   its messages array is separate from the parent's.
4. **Return the result** — the subagent's **final assistant text** becomes the **single `tool_result`** handed
   back to the parent. The parent never sees the child's intermediate steps — only the distilled answer.
5. The parent continues its loop with that result appended. (Richer implementations stream progress +
   support background/async, worktree/remote isolation — we defer those.)

### Built-in agent types (the common set; we'll start with 1–2)
`general-purpose` (full tools), `explore` (read-only search, returns findings), `plan` (architect, no edits).
Each = a **system prompt + a tool subset**. The `subagent_type` selects which.

### Edge cases to rule out (critical)
1. **Infinite recursion** (subagent spawns subagent spawns…) → **depth cap** in `ToolContext` (e.g. ≤2) AND
   **remove the Subagent tool from the child's tool set** (belt + suspenders).
2. **Runaway child** → the child loop's own `maxTurns` guard applies.
3. **Permissions mid-delegation** — a child prompting for a write is awkward (it's "headless"). Default
   subagents to a **read-only tool subset** (Read/Glob/Grep/Bash-readonly) so they explore without prompts;
   writes stay with the parent. (Or inherit the parent's permission controller.)
4. **Abort** — parent abort must cancel the child → **share the AbortSignal** down.
5. **Child failure** → return an **error `tool_result`** ("subagent failed: …"), parent adapts (don't crash).
6. **Cost/latency** — a subagent is a full nested loop (many model calls). Worth it only for genuinely
   separable, context-heavy subtasks (big search, independent investigation).
7. **Result size** → the returned summary is the tool_result; keep it bounded.
8. **Memory/tracer** — child shares the tracer (nested activity is visible) but should NOT auto-curate the
   parent's memory.

### Cascade design
`tools/builtins/Subagent.ts` — `Task` tool `{ description, prompt, subagent_type? }`. `call()`:
- guard depth (`ctx.depth ?? 0` ≥ cap → error result);
- build a child registry = parent tools **minus Subagent** (and minus writes for read-only types);
- `recent = []`; `yield*`/await a nested `runAgentLoop([{role:user, content: prompt}], { provider, model, cwd,
  signal: ctx.abortSignal, registry: childRegistry, tracer: ctx.tracer, depth: depth+1 })`;
- collect the final `message` text → return as the tool_result.
- Built-ins: `general-purpose` + `explore` (read-only) to start.

Defer: background/async agents, worktree/remote isolation, agent teams (collaborative), MCP-per-agent.

---

## Sources
Production retry practice (taxonomy, backoff, fallback, overflow) and delegation practice (delegation tool,
nested runner, built-in agent types); a published engineering write-up on building a multi-agent research
system; multi-agent coordination-pattern guides; LLM retry/backoff-with-jitter + 429/529 best-practice
articles.
