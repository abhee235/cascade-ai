import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleConnection } from '../src/wsServer'
import { ProjectManager } from '../src/projectManager'
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

/** A ProjectManager whose sessions are fake (no Ollama), rooted in a throwaway temp dir. */
function fakeManager() {
  const root = mkdtempSync(join(tmpdir(), 'cascade-proj-'))
  return new ProjectManager({
    root,
    model: 'fake',
    createSessionFor: (dir) => createSession({ cwd: dir, provider: fakeProvider, model: 'fake' }),
  })
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

/** Last `projects` snapshot the server sent. */
const lastProjects = (ws: MockWs) =>
  [...ws.sent].reverse().find((e) => e.type === 'projects') as
    | { projects: { id: string }[]; activeId?: string }
    | undefined

describe('wsServer — projects + ActivityEvent relay over the socket (13.2)', () => {
  it('greets a new connection with a project list', () => {
    const ws = new MockWs()
    handleConnection(ws as never, fakeManager())
    expect(ws.sent[0]).toMatchObject({ type: 'projects', projects: [] })
  })

  it('create → open → submit streams text_delta + final message + turnDone', async () => {
    const ws = new MockWs()
    handleConnection(ws as never, fakeManager())

    ws.emit('message', JSON.stringify({ type: 'project', action: 'create', name: 'Demo' }))
    await waitFor(() => (lastProjects(ws)?.projects.length ?? 0) === 1)
    const id = lastProjects(ws)!.projects[0].id

    ws.emit('message', JSON.stringify({ type: 'project', action: 'open', id }))
    await waitFor(() => lastProjects(ws)?.activeId === id)

    ws.emit('message', JSON.stringify({ type: 'submit', text: 'hi' }))
    await waitFor(() => ws.sent.some((e) => e.type === 'turnDone'))

    const types = ws.sent.map((e) => e.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('message')
    expect(types).toContain('turnDone')
    const msg = ws.sent.find((e) => e.type === 'message') as { message: { content: { text?: string }[] } }
    expect(JSON.stringify(msg.message.content)).toContain('Hello from the server')
  })

  it('submit with no project open → prompts to open one (does not crash)', async () => {
    const ws = new MockWs()
    handleConnection(ws as never, fakeManager())
    ws.emit('message', JSON.stringify({ type: 'submit', text: 'hi' }))
    await waitFor(() => ws.sent.some((e) => e.type === 'turnDone'))
    const msg = ws.sent.find((e) => e.type === 'message') as { message: { content: { text?: string }[] } }
    expect(JSON.stringify(msg.message.content)).toContain('Open or create a project')
  })

  it('ignores malformed JSON without emitting anything beyond the initial greeting', async () => {
    const ws = new MockWs()
    handleConnection(ws as never, fakeManager())
    const before = ws.sent.length // the projects greeting
    ws.emit('message', 'not json{')
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sent).toHaveLength(before) // no additional output, no throw
  })
})
