# Local observability (ADR-053)

Cascade records every session as a forensic JSONL trace (ADR-023). Three ways to consume one, from
lightest to richest:

## 1. Terminal timeline (no setup)

```sh
npx tsx scripts/eval/timeline.mts <trace.jsonl>          # per-turn story: calls, results, compactions
npx tsx scripts/eval/timeline.mts <trace.jsonl> --full   # untruncated text/inputs
```

## 2. Phoenix — the visual waterfall (one container)

```sh
docker run -d --name cascade-phoenix -p 6006:6006 arizephoenix/phoenix:latest
# open http://localhost:6006
```

**Backfill any existing trace** (eval runs AND real product sessions — `.cascade/trace-*.jsonl` in any
project folder), original timestamps preserved:

```sh
npx tsx scripts/eval/otelBackfill.mts eval/runs/<label>/traces/<task>.jsonl
npx tsx scripts/eval/otelBackfill.mts <project>/.cascade/trace-2026-….jsonl --service my-project
```

**Live-trace an eval/builder run** — set the endpoint env; the runners fan out to JSONL + OTLP:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces \
  npx tsx scripts/eval/builder.mts --model qwen36-agentic:latest --scenarios builder-shop
```

What you see per submit: an AGENT root span → one LLM span per model turn (real token counts, latency,
text preview) → one TOOL span per call (input, result, errors red) → compactions/nudges/verify-gates as
span events on the root. Failed tools and errored runs are loud.

Langfuse works identically (it ingests the same OTLP) — point the endpoint at
`https://<your-langfuse>/api/public/otel/v1/traces` with its auth headers when you want scoring/datasets
in a UI. Phoenix stays the default for local troubleshooting.

## 3. Send a trace to an AI assistant

Traces are files — in a coding agent with file access, just ask: *“analyze eval/runs/<label>/traces/<task>.jsonl”*.
For a chat assistant (no file access to your machine), paste a digest:

```sh
npx tsx scripts/eval/timeline.mts <trace.jsonl> > digest.txt   # paste-ready
```
