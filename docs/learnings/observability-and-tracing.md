# Learning: tracing the agent end-to-end (audit/logs) — and library vs self-code

## Q: Should we add audit/logging to trace the agent end-to-end and debug what went wrong? Library or self-code?
**Yes — and self-code a tiny JSONL tracer; defer SaaS/OpenTelemetry.** Best added around Phase 7–8,
before the hardest-to-debug phases (Bash, MCP, compaction, resilience, subagents) where a local model
misbehaves and the webview alone isn't enough evidence. It complements tests (ADR-022): tests catch
regressions offline; traces explain *live* failures with the real model.

## The key insight
Cascade already emits a serializable event stream (`ActivityEvent`). But that's the **display** layer —
it truncates (`preview.slice(0,200)`) and omits the raw model I/O. A useful trace taps the layer
**below** display, at these seams:
- each `provider.stream` call — the FULL request (`messages`, `system`, `tools`) + raw response + usage/timing
  (← most failures are "the prompt we sent ≠ what we thought" or "model emitted malformed tool JSON")
- each `tool_use` → `tool_result` — full input, full output, isError, duration
- permission gate — tool, decision, mode
- session.submit / InboundMessage (user text, permission answer, abort), turn boundaries, errors

## Library vs self-code
- **LLM-obs SaaS** (LangSmith, Langfuse, Helicone, Phoenix, Braintrust) — hosted servers, auth, cloud-LLM
  assumptions; overkill and hides the mechanism. Defer.
- **OpenTelemetry / OpenLLMetry** — vendor-neutral standard, the right answer *if you outgrow JSONL and
  want any backend*; SDK is heavy (span/context ceremony). Defer; note as the upgrade path.
- **Logging libs** (pino/winston) — solve levels/transports, not structured events. pino could be the
  JSONL writer, but plain `fs` is clearer for a tutorial.
- **Self-coded JSONL** (one JSON object per line, append-only, `.cascade/trace-<ts>.jsonl`) — greppable,
  jq-able, ~60–100 lines, headless, zero deps, teaches the concept. ✅ chosen.

## Proposed design (ADR-023) — DI, like the provider (ADR-020)
- `Tracer { event(e: TraceEvent): void }` — headless interface; default no-op.
- `JsonlTracer(path)` — appends one JSON line per event.
- Injected via `SessionOptions.tracer`; session/loop call `tracer.event(...)` at the seams. Tests inject a
  capturing tracer; extension wires `JsonlTracer` behind a `cascade.trace` setting.
- Keep it a SINK separate from `ActivityEvent` (display) — overlapping but richer (full, untruncated, +timing).

## Prior art
Production agents commonly persist every session as a **`.jsonl` transcript** (one message/event per line),
plus optional **OpenTelemetry** metrics/logs. So "JSONL transcript now, OTEL later" mirrors that common
split. — [[permissions-vs-sandbox]] sibling concern: this is observability, that was safety.

## Future concerns (not now)
Prompt/PII size + redaction; log rotation/size caps; sampling; turning full-request capture off by default
in shared deployments.
