// scripts/eval/otelBackfill.mts — ADR-053: replay ANY existing Cascade trace (.jsonl) into an OTLP viewer
// (Phoenix, Langfuse) with ORIGINAL timestamps. Eval runs and real product sessions alike become
// browsable retroactively — live streaming is a nicety, not a prerequisite.
//
//   npx tsx scripts/eval/otelBackfill.mts <trace.jsonl> [--endpoint http://localhost:6006/v1/traces] [--service name]
//
// Endpoint default targets a local Phoenix (docker run -p 6006:6006 arizephoenix/phoenix).

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { OtelTracer } from './otelTracer.mts'

const { values: args, positionals } = parseArgs({
	options: {
		endpoint: { type: 'string', default: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://localhost:6006/v1/traces' },
		service: { type: 'string' },
	},
	allowPositionals: true,
})
const file = positionals[0]
if (!file) {
	console.error('usage: otelBackfill.mts <trace.jsonl> [--endpoint url] [--service name]')
	process.exit(2)
}

const events = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l))

const tracer = new OtelTracer({
	endpoint: args.endpoint!,
	service: args.service ?? `cascade:${basename(file, '.jsonl')}`,
	attributes: { 'cascade.backfill': 'true', 'cascade.trace_file': basename(file) },
})

// A product session file can hold MANY submits; the tracer handles consecutive roots naturally.
// Traces cut off mid-run (aborts, crashes) get a synthetic turn_done so open spans still export.
let open = false
for (const e of events) {
	if (e.t === 'submit') {
		if (open) tracer.event({ t: 'turn_done', turns: -1, ts: e.ts } as never)
		open = true
	}
	tracer.event(e)
	if (e.t === 'turn_done') open = false
}
if (open && events.length) tracer.event({ t: 'turn_done', turns: -1, ts: events[events.length - 1].ts } as never)

await tracer.forceFlush()
await tracer.shutdown()
console.log(`backfilled ${events.length} events from ${basename(file)} → ${args.endpoint}`)
