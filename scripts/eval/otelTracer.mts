// scripts/eval/otelTracer.mts — MOVED to packages/server/src/otelTracer.ts (ADR-053 amendment), so the
// product server can stream live to an OTLP viewer instead of only replaying traces after the fact.
// Kept as a re-export: the eval runner (builder.mts), the backfill (otelBackfill.mts) and the unit test
// import it from here, and none of them should care where it lives.

export { fanout, OtelTracer, type OtelTracerOptions } from '../../packages/server/src/otelTracer'
