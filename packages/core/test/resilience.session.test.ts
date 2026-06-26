import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { createSession } from '../src/session'
import type { ModelProvider } from '../src/llm/provider'
import type { ActivityEvent } from '../src/protocol'

// A provider that's "down" like a killed Ollama: every call throws a connection error.
const downProvider: ModelProvider = {
  id: 'down',
  async complete() {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  },
  async *stream() {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    // eslint-disable-next-line no-unreachable
    yield { type: 'done', stopReason: 'end_turn' } as never
  },
}

describe('resilience — session survives a dead provider', () => {
  it('submit yields a clean error message + turnDone (does NOT throw / kill the chat)', async () => {
    const session = createSession({ cwd: tmpdir(), provider: downProvider, model: 'fake', recovery: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } })
    const events: ActivityEvent[] = []
    // The whole point: iterating submit must not throw — the session catches and surfaces an error.
    for await (const e of session.submit('hello')) events.push(e)

    expect(events.some((e) => e.type === 'message')).toBe(true) // an error message was shown
    expect(events.some((e) => e.type === 'turnDone')).toBe(true) // turn ended cleanly (UI unblocks)
    // retries were visible to the user (a persistent recovery card), not a silent hang
    expect(events.some((e) => e.type === 'recovering')).toBe(true)
  })
})
