import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { scheduleTools } from '../src/tools/scheduler'
import { createSession, type CascadeSession } from '../src/session'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import type { ToolContext } from '../src/tools/Tool'
import type { ActivityEvent, ContentBlock } from '../src/protocol'
import type { PermissionController, PermissionState } from '../src/permissions/gate'
import type { ToolUse } from '../src/tools/runTool'

// Drive the generator to completion, collecting yielded events AND the returned tool_result[].
async function drain(gen: AsyncGenerator<ActivityEvent, ContentBlock[]>) {
  const events: ActivityEvent[] = []
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    r = await gen.next()
  }
  return { events, result: r.value }
}

const state = (over: Partial<PermissionState> = {}): PermissionState => ({
  mode: 'default',
  allow: new Set(),
  deny: new Set(),
  ...over,
})

// A controller whose prompt resolves instantly to a scripted answer (no real UI).
const controller = (st: PermissionState, answer: 'allow' | 'allow-always' | 'deny'): PermissionController => ({
  state: st,
  request: async () => answer,
})

const write = (id: string, file_path: string): ToolUse => ({ id, name: 'Write', input: { file_path, content: 'x' } })
const read = (id: string, file_path: string): ToolUse => ({ id, name: 'Read', input: { file_path } })

describe('scheduleTools — permission gating', () => {
  it('denies a write: yields a permission event, never executes, returns an error tool_result', async () => {
    const st = state()
    const ctx: ToolContext = { cwd: tmpdir(), abortSignal: new AbortController().signal, permission: controller(st, 'deny') }
    const { events, result } = await drain(scheduleTools([write('1', 'should-not-exist.txt')], ctx))

    expect(events.find((e) => e.type === 'permission')).toMatchObject({ type: 'permission', id: '1', tool: 'Write' })
    expect(result[0]).toMatchObject({ type: 'tool_result', isError: true })
    expect((result[0] as any).content).toMatch(/denied/i)
  })

  it('allow-always runs the write AND remembers the tool for the session', async () => {
    const st = state()
    const path = join(tmpdir(), `cascade-perm-${Date.now()}.txt`)
    const ctx: ToolContext = { cwd: tmpdir(), abortSignal: new AbortController().signal, permission: controller(st, 'allow-always') }
    const { result } = await drain(scheduleTools([write('1', path)], ctx))

    expect((result[0] as any).isError).toBeFalsy()
    expect(await readFile(path, 'utf8')).toBe('x')
    expect(st.allow.has('Write')).toBe(true) // remembered → next write won't ask
    await rm(path, { force: true })
  })

  it('never prompts for a read (auto-allow): no permission event', async () => {
    const st = state()
    const ctx: ToolContext = { cwd: tmpdir(), abortSignal: new AbortController().signal, permission: controller(st, 'deny') }
    const { events } = await drain(scheduleTools([read('1', 'package.json')], ctx))
    expect(events.some((e) => e.type === 'permission')).toBe(false)
  })
})

// Drive a real session turn, auto-answering any permission prompt. NOTE the ordering: the scheduler
// registers its resolver only DURING the .next() after the `permission` yield — so we kick off .next()
// FIRST, then respondPermission, then await. Calling respond before .next() would no-op and hang.
async function drive(session: CascadeSession, text: string, decision: 'allow' | 'allow-always' | 'deny') {
  const events: ActivityEvent[] = []
  const gen = session.submit(text)[Symbol.asyncIterator]()
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    if (r.value.type === 'permission') {
      const next = gen.next() // resumes the scheduler: perm.request() runs → resolver registered
      session.respondPermission(r.value.id, decision)
      r = await next
      continue
    }
    r = await gen.next()
  }
  return events
}

describe('session — reset() forgets allow-always grants', () => {
  it('after New chat, a previously allow-always tool prompts again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-reset-'))
    try {
      const provider = createFakeProvider([
        [toolUse('w1', 'Write', { file_path: 'a.txt', content: 'a' }), done('tool_use')],
        [textDelta('ok'), done('end_turn')],
        [toolUse('w2', 'Write', { file_path: 'b.txt', content: 'b' }), done('tool_use')],
        [textDelta('ok2'), done('end_turn')],
      ])
      const session = createSession({ cwd: dir, provider, model: 'fake' })

      const e1 = await drive(session, 'write a', 'allow-always') // grant always-allow Write
      expect(e1.some((e) => e.type === 'permission')).toBe(true)

      session.reset() // New chat → should forget the grant

      const e2 = await drive(session, 'write b', 'deny')
      expect(e2.some((e) => e.type === 'permission')).toBe(true) // asks AGAIN → reset cleared it
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
