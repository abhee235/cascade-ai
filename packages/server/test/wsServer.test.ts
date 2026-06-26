import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { handleConnection } from '../src/wsServer'
import { createSession, type ModelProvider } from '@cascade/core'

// Minimal in-process provider — no Ollama, deterministic.
const fakeProvider: ModelProvider = {
  id: 'fake',
  async complete() {
    return { text: '' }
  },
  async *stream() {
    yield { type: 'text_delta', text: 'Hello from the server' }
    yield { type: 'done', stopReason: 'end_turn' }
  },
}

// A stand-in for the `ws` WebSocket: records everything sent.
class MockWs extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: Array<Record<string, unknown>> = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
}

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('wsServer — relays the ActivityEvent protocol over the socket', () => {
  it('submit → streams text_delta + a final message + turnDone back as JSON', async () => {
    const session = createSession({ cwd: tmpdir(), provider: fakeProvider, model: 'fake' })
    const ws = new MockWs()
    handleConnection(ws as never, session)

    ws.emit('message', JSON.stringify({ type: 'submit', text: 'hi' }))
    await waitFor(() => ws.sent.some((e) => e.type === 'turnDone'))

    const types = ws.sent.map((e) => e.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('message')
    expect(types).toContain('turnDone')
    const msg = ws.sent.find((e) => e.type === 'message') as { message: { content: { text?: string }[] } }
    expect(JSON.stringify(msg.message.content)).toContain('Hello from the server')
  })

  it('ignores malformed JSON without crashing', async () => {
    const session = createSession({ cwd: tmpdir(), provider: fakeProvider, model: 'fake' })
    const ws = new MockWs()
    handleConnection(ws as never, session)
    ws.emit('message', 'not json{')
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sent).toHaveLength(0) // no output, no throw
  })
})
