import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryStorage } from '../src/createStorage.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'cascade-cs-')), 'nested', 'cascade.db')

describe('createTelemetryStorage', () => {
  it('creates missing parent dirs — first launch has no app-data dir', () => {
    const f = file()
    const s = createTelemetryStorage({ file: f })
    expect(existsSync(f)).toBe(true)
    return s.dispose()
  })

  it('dispose() flushes buffered spans — they live in memory until then', async () => {
    const f = file()
    const a = createTelemetryStorage({ file: f })
    a.traces.record({ traceId: 'T', spanId: 's1', name: 'agent', kind: 'AGENT', startedAt: Date.now() })
    await a.dispose()
    // Reopening proves it reached disk, not just the buffer.
    const b = createTelemetryStorage({ file: f })
    expect(await b.traces.spans('T')).toHaveLength(1)
    await b.dispose()
  })

  it('prunes stale spans at OPEN, and honours retention: 0', async () => {
    const f = file()
    const a = createTelemetryStorage({ file: f })
    a.traces.record({ traceId: 'old', spanId: 'o', name: 'x', kind: 'AGENT', startedAt: 1 })
    await a.dispose()

    const keep = createTelemetryStorage({ file: f, retentionMs: 0 })
    expect(await keep.traces.spans('old')).toHaveLength(1)
    await keep.dispose()

    const pruned = createTelemetryStorage({ file: f, retentionMs: 60_000 })
    await pruned.traces.flush()
    expect(await pruned.traces.spans('old')).toHaveLength(0)
    await pruned.dispose()
  })
})
