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

  it('a max_tokens cut-off with no tool call CONTINUES (act-now nudge), not terminates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-'))
    try {
      const provider = createFakeProvider([
        // turn 1: a long thinking spiral cut off at the output ceiling — no tool call
        [textDelta('planning planning planning'), done('max_tokens')],
        // turn 2: after the nudge, the model finally acts and answers
        [textDelta('Done.'), done('end_turn')],
      ])
      const events = await collect(runAgentLoop([{ role: 'user', content: 'build it' }], deps(provider, dir)))

      // It did NOT stop after the cut-off turn — a second call happened, prompted by the nudge.
      expect(provider.calls.length).toBe(2)
      // The nudge (an "act now" system-reminder) was injected before the retry.
      expect(JSON.stringify(provider.calls[1].messages)).toMatch(/CUT OFF at the output limit/i)
      // And it did eventually finish.
      expect(events.some((e) => e.type === 'turnDone')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a persistent max_tokens spiral is bounded by strikes, not infinite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-'))
    try {
      // Every turn spirals and gets cut off — the strike budget must stop it (not loop forever).
      const turns = Array.from({ length: 12 }, () => [textDelta('spiral'), done('max_tokens')] as const)
      const provider = createFakeProvider(turns as any)
      const events = await collect(runAgentLoop([{ role: 'user', content: 'go' }], deps(provider, dir, 20)))
      // MAX_TOKENS_STRIKES = 3 continuations, then the turn is accepted as terminal → 4 calls total, not 12/20.
      expect(provider.calls.length).toBe(4)
      expect(events.some((e) => e.type === 'turnDone')).toBe(true)
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
