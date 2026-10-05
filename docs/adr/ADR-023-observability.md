# ADR-023 — Observability: trace the agent end-to-end (JSONL)

**Status:** Accepted (inserted after Phase 7; pairs with ADR-022 testing)

## Context
The agent is now complex (loop → model → scheduler → permissions → tools) and driven by a *local* model
that misbehaves in surprising ways. When a turn hangs or returns a weird answer, the webview alone isn't
enough evidence. The upcoming phases (Bash, MCP, compaction, resilience, subagents) are the hardest to
debug. We need to trace the run **end-to-end** to answer "what went wrong?" — and we want to do it without
obscuring the mechanism we're trying to teach.

## Decision
Add a **self-coded JSONL tracer**, injected by DI like the provider (ADR-020):
- `observability/tracer.ts`: a `Tracer { event(e: TraceEvent): void }` interface, a `NoopTracer` (default),
  and a `JsonlTracer(path)` that appends one stamped JSON object per line.
- `TraceEvent` is a **second event stream, distinct from `ActivityEvent`**: ActivityEvent is for *display*
  (truncated previews, no raw model I/O); TraceEvent is for *forensics* — the FULL `model_request`
  (messages/system/tools), `model_response`, `tool_call`/`tool_result` (untruncated, + timing),
  `permission` decisions, `turn_done`, `error`.
- Injected via `SessionOptions.tracer` → threaded to `LoopDeps` and `ToolContext`. The session traces
  submit/error; the loop traces model_request/response/turn_done; the scheduler traces
  permission/tool_call/tool_result. Default `NoopTracer` ⇒ tests and headless smokes stay silent.
- The extension constructs a `JsonlTracer` behind a `cascade.trace` setting, writing
  `<workspace>/.cascade/trace-<timestamp>.jsonl` (`.cascade/` is git-ignored).

**Why not a library?** Hosted LLM-observability SaaS products assume cloud LLMs and hide the mechanism.
OpenTelemetry (with its LLM semantic conventions) is the right *standard* if we outgrow JSONL, but its
span/context SDK is heavy ceremony for a tutorial. General logging libraries solve levels/transports,
not structured events. JSONL is ~40 lines, zero deps, greppable, and teaches the idea. See
`docs/learnings/observability-and-tracing.md`.

## Consequences
- One readable timeline per run; the `model_request` line in particular exposes the #1 failure class
  ("the prompt we actually sent ≠ what we assumed") and malformed tool JSON.
- Tests can inject a capturing tracer and assert the sequence of events (deterministic, no files).
- Tracer is a SINK, fully decoupled from display — turning it off changes nothing about behavior.
- Upgrade path preserved: a future `OtelTracer implements Tracer` can emit spans without touching callers.

## Prior art
Agents commonly persist every session as a `.jsonl` transcript (one message/event per line) and support
OpenTelemetry metrics/logs plus a `--debug` flag. "JSONL now, OTEL later" follows that split.
