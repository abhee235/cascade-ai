import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../src/agent/agentLoop'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import type { ActivityEvent, Message } from '../src/protocol'

async function collect(gen: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const out: ActivityEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}
const deps = (provider: any, cwd: string, maxTurns?: number) => ({
  provider,
  model: 'fake',
  cwd,
  signal: new AbortController().signal,
  maxTurns,
})

describe('runAgentLoop', () => {
  it('runs a tool, feeds the result back, then terminates when no more tool_use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-'))
    try {
      await writeFile(join(dir, 'pkg.json'), '{"name":"x"}')
      const provider = createFakeProvider([
        [textDelta("I'll read it"), toolUse('c1', 'Read', { file_path: 'pkg.json' }), done('tool_use')],
        [textDelta('The name is x'), done('end_turn')],
      ])
      const messages: Message[] = [{ role: 'user', content: 'read pkg.json' }]
      const events = await collect(runAgentLoop(messages, deps(provider, dir)))

      const types = events.map((e) => e.type)
      expect(types).toContain('toolStart')
      expect(types).toContain('toolResult')

      const lastMsg: any = events.filter((e) => e.type === 'message').pop()
      expect(lastMsg.message.content.map((b: any) => b.text ?? '').join('')).toContain('The name is x')

      // Two model calls (turn 1 tool, turn 2 answer); turn 2 saw the tool_result.
      expect(provider.calls.length).toBe(2)
      expect(JSON.stringify(provider.calls[1].messages)).toContain('tool_result')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops at maxTurns when the model keeps calling tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-'))
    try {
      await writeFile(join(dir, 'f.txt'), 'x')
      const turns = Array.from({ length: 10 }, (_, i) => [toolUse('c' + i, 'Read', { file_path: 'f.txt' }), done('tool_use')])
      const provider = createFakeProvider(turns)
      const events = await collect(runAgentLoop([{ role: 'user', content: 'loop' }], deps(provider, dir, 3)))
      expect(provider.calls.length).toBe(3) // capped, not infinite
      expect(events.some((e) => e.type === 'turnDone')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
