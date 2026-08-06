// The END-TO-END proof for ADR-081 §5–6: a real turn's events reach a real SQLite file.
//
// The unit tests either side of this seam both passed while the seam itself did not exist — the tracer
// worked, the store worked, and nothing constructed either. So this test deliberately uses the PRODUCT
// path: ProjectManager's own default session factory (not the injected test one), the real
// createTelemetryStorage, and the real createSqliteTracer, wired exactly as main.ts wires them.
//
// Importing the adapter is allowed HERE and not in src/ — storageBoundary.test.ts walks src only, and a
// test asserting the desktop adapter behaves is by definition deployment-specific.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryStorage } from '@cascade/storage-sqlite'
import { createSpanTracer, type ModelProvider } from '@cascade/core'
import { ProjectManager } from '../src/projectManager'

/** Answers every turn with one line and no tool calls, so a submit completes without a backend. */
const fakeProvider: ModelProvider = {
  id: 'fake',
  async complete() {
    return { text: 'done' }
  },
  async *stream() {
    yield { type: 'text_delta', text: 'done' }
    yield { type: 'done', stopReason: 'end_turn' }
  },
}

describe('ADR-081 telemetry wiring (product path)', () => {
  it('a real submit lands spans in the SQLite store the Observatory reads', async () => {
    const storage = createTelemetryStorage({ file: join(mkdtempSync(join(tmpdir(), 'cascade-wire-')), 'cascade.db') })
    const seen: { projectId?: string; kind: string; model?: string }[] = []
    const mgr = new ProjectManager({
      root: mkdtempSync(join(tmpdir(), 'cascade-pm-wire-')),
      model: 'fake',
      // NOT overriding createSessionFor: that is the whole point — the default factory is what calls
      // tracerFor, and overriding it would test the test's own wiring instead of the product's.
      createProviderFn: () => fakeProvider,
      sessionTracerFor: (info) => {
        seen.push(info)
        // main.ts's wiring, verbatim: core's ONE fold, sinking straight into the store.
        return createSpanTracer((span) => storage.traces.record(span), { projectId: info.projectId, model: info.model, rootName: `agent (${info.kind})` })
      },
    })

    const p = mgr.create('Wire Test', 'react')
    const session = mgr.open(p.id)
    for await (const _ of session.submit('hello')) {
      /* drain */
    }

    // The factory is handed the project ID and NOT the dir — the dir is absent from the type on purpose.
    expect(seen).toEqual([{ projectId: p.id, kind: 'builder', model: 'fake' }])

    const traces = await storage.traces.listTraces()
    expect(traces).toHaveLength(1)
    expect(traces[0].name).toBe('agent (builder)')
    expect(traces[0].model).toBe('fake')
    // The span is stamped with the project ID, never the host dir: these rows are read back BY A CLIENT,
    // and a host path must not cross the wire (ProjectInfo). Storing the dir would mean either leaking it
    // or translating on every query.
    expect(traces[0].projectId).toBe(p.id)
    expect(traces[0].projectId).not.toContain('cascade-pm-wire')

    // The LLM span is the one that matters: it carries the tokens/timings every diagnosis this cycle
    // depended on. Its presence proves the fanout reached the store, not just that a root was written.
    const spans = await storage.traces.spans(traces[0].traceId)
    expect(spans.map((s) => s.kind)).toContain('LLM')

    await storage.dispose()
    await mgr.dispose()
  })

  it('no sessionTracerFor ⇒ the fanout is exactly what it was (headless/tests pay nothing)', async () => {
    const mgr = new ProjectManager({
      root: mkdtempSync(join(tmpdir(), 'cascade-pm-none-')),
      model: 'fake',
      createProviderFn: () => fakeProvider,
    })
    const session = mgr.open(mgr.create('No Telemetry', 'react').id)
    for await (const _ of session.submit('hello')) {
      /* drain — must not throw with the injection absent */
    }
    await mgr.dispose()
  })
})
