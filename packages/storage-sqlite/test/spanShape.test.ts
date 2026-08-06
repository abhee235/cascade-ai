// core's `TraceSpan` and storage's `SpanRecord` are declared separately on purpose: core must not depend
// on the storage package, nor storage on core. Structural typing makes `traces.record(span)` work without
// a conversion — but only while the two shapes agree, and nothing else would notice if they stopped.
//
// This is the same discipline as the rest of the ADR-081 amendment: the whole point of collapsing the two
// folds was that duplication drifts silently. The duplicated TYPE gets a guard too.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpanTracer, type TraceSpan } from '@cascade/core'
import type { SpanRecord } from '@cascade/storage'
import { openDb } from '../src/db.js'
import { createTraceStore } from '../src/traceStore.js'

// Compile-time: each must be assignable to the other. A field added to one and not the other fails here
// (typecheck) before it can fail as a missing column at runtime.
type AssertAssignable<A extends B, B> = [A, B]
type _CoreFitsStorage = AssertAssignable<TraceSpan, SpanRecord>
type _StorageFitsCore = AssertAssignable<SpanRecord, TraceSpan>

describe('TraceSpan ≡ SpanRecord (ADR-081)', () => {
  it('core spans flow into the store with no conversion', async () => {
    const store = createTraceStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-shape-')), 'x.db')))
    // The product wiring, verbatim: main.ts passes `traces.record` as the sink.
    const tracer = createSpanTracer((span) => store.record(span), { traceId: 'T', projectId: 'p1', model: 'qwen', rootName: 'agent (builder)' })
    tracer.event({ t: 'submit', text: 'hi' })
    tracer.event({ t: 'turn_done', turns: 1 })
    const spans = await store.spans('T')
    expect(spans.map((s) => s.kind)).toEqual(['AGENT'])
    expect(spans[0].attributes?.input).toBe('hi')
  })
})
