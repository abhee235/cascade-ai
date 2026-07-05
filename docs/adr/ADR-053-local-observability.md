# ADR-053 — Local observability: one OTel exporter, any viewer (Phoenix first)

> **Status:** accepted (user decision, 2026-07-05); implementing now.

## Context

Cascade already records everything (ADR-023 JsonlTracer: every model request/response with real token
counts, every tool call/result with timings, compactions, nudges, gates, errors — the forensic record that
drove every rung this week). But the consumption story is asymmetric: an AI assistant can walk a JSONL trace;
a human cannot. The user needs to SEE the flow — expand a turn, scan the waterfall, spot the stall — to
troubleshoot manually. Hand-building a viewer would be a worse version of tools that already exist:
**Arize Phoenix** and **Langfuse** are purpose-built LLM trace UIs, both self-hostable, both ingesting
**OpenTelemetry**.

## Decision

1. **One exporter, not N integrations.** A single `OtelTracer` implements Cascade's existing `Tracer`
   interface and maps the event stream onto OTel spans:
   - `submit … turn_done` → a root AGENT span per submit;
   - `model_request … model_response` → an LLM span (model, latency, `gen_ai.usage.input_tokens` /
     `output_tokens` from the REAL backend counts, text previews as input/output values);
   - `tool_call … tool_result` → a TOOL span per call (name, input JSON, result preview, error flag,
     `repaired` flag from the item-4a ladder);
   - `compaction` / `delegate_nudge` / `verify_gate` / `error` → span events on the root (the harness's
     own interventions must be visible in the same waterfall as the model's actions).
   Attributes carry both the `gen_ai.*` conventions (Langfuse) and `openinference.span.kind`
   (Phoenix), so either UI renders it natively.
2. **Placement: the instrument layer, not core.** The exporter lives with the eval scripts and is wired
   by the runners (env `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `--otel`); core keeps zero new
   dependencies. Product sessions don't stream live in v1 — they don't need to, because of (3).
3. **Backfill covers every trace that ever existed.** `otelBackfill.mts <trace.jsonl>` replays ANY
   existing trace — eval runs AND the user's real product sessions (`.cascade/trace-*.jsonl`) — into the
   viewer with original timestamps. Old runs become browsable retroactively; live streaming from the
   extension/server becomes a follow-up, not a prerequisite.
4. **Viewer: Phoenix first** — lightest local footprint (one container / `pip install`, no DB), exactly
   the troubleshoot-a-waterfall UI needed. Langfuse stays one env-var away (same OTLP) when
   scoring/datasets in a UI are wanted.
5. **"Send to an assistant" needs no new tool.** Traces are files; any coding agent reads files — "analyze
   `<trace path>`" is the whole workflow. For a web chat assistant, `timeline.mts <trace> > digest.txt`
   produces a paste-ready digest. We deliberately do NOT build API-key plumbing into a viewer.

## Consequences

- The user gets a real trace UI (waterfall, filters, token/latency views) for the cost of one exporter
  and a docker one-liner — including for every trace already on disk.
- The exporter is inert unless an endpoint is configured (no-overfitting rule's operational cousin:
  zero behavior/dependency change for sessions that don't opt in).
- Verification: unit test maps a synthetic event stream through the tracer into an in-memory exporter
  and asserts the span tree (root AGENT → LLM turns + TOOL children, token attributes, compaction
  events); live check = backfill the builder-shop forensic trace and eyeball it in Phoenix.

[tracer.ts]: ../../packages/core/src/observability/tracer.ts
