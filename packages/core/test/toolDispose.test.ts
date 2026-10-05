import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { createSession } from '../src/session'
import type { ModelProvider } from '../src/llm/provider'
import type { Tool } from '../src/tools/Tool'

// ADR-086 P0: session.dispose() releases the tools the caller handed it (Tool.dispose). Measured before: the
// Browser tool's headless Edge outlived every session, and the bench process never exited.
const idle: ModelProvider = {
  id: 'idle',
  async complete() {
    throw new Error('not called')
  },
  async *stream() {
    yield { type: 'done', stopReason: 'end_turn' } as never
  },
}

const tool = (name: string, dispose?: () => Promise<void>): Tool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  activitySummary: () => name,
  call: async () => ({ content: '' }),
  ...(dispose ? { dispose } : {}),
})

describe('session.dispose releases the extra tools it was given', () => {
  it('calls each dispose once; one that fails (async or sync) does not keep the others open', async () => {
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {
      throw new Error('async failure')
    })
    const c = vi.fn((): Promise<void> => {
      throw new Error('sync failure')
    })
    const d = vi.fn(async () => {})
    const session = createSession({ cwd: tmpdir(), provider: idle, model: 'fake', autoMemory: false, extraTools: [tool('A', a), tool('B', b), tool('Plain'), tool('C', c), tool('D', d)] })
    await session.dispose()
    expect([a, b, c, d].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1])
  })
})
