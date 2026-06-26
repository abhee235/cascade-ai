import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { runAgentLoop } from '../src/agent/agentLoop'
import { SubagentTool } from '../src/tools/builtins/Subagent'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import type { ActivityEvent, Message } from '../src/protocol'
import type { ToolContext } from '../src/tools/Tool'

const bypass = { state: { mode: 'bypass' as const, allow: new Set<string>(), deny: new Set<string>() }, request: async () => 'allow' as const }
async function collect(gen: AsyncIterable<ActivityEvent>) {
  const out: ActivityEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}
const text = (m: Message) => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))

describe('Subagent tool', () => {
  it('refuses when nesting is not allowed (no spawn closure = at depth cap)', async () => {
    const ctx = { cwd: tmpdir(), abortSignal: new AbortController().signal } as ToolContext // no spawnSubagent
    const res = await SubagentTool.call({ description: 'x', prompt: 'do x' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/nested further|depth/i)
  })

  it('delegates to the injected spawn closure and returns its result', async () => {
    let seen: { prompt: string; readOnly?: boolean } | undefined
    const ctx = {
      cwd: tmpdir(),
      abortSignal: new AbortController().signal,
      spawnSubagent: async (opts: { prompt: string; readOnly?: boolean }) => {
        seen = opts
        return 'subagent summary'
      },
    } as unknown as ToolContext
    const res = await SubagentTool.call({ description: 'find', prompt: 'search the repo', subagent_type: 'explore' }, ctx)
    expect(res.content).toBe('subagent summary')
    expect(seen).toMatchObject({ prompt: 'search the repo', readOnly: true }) // explore ⇒ read-only
  })

  it('e2e: a nested loop runs and ONLY its final summary returns to the parent', async () => {
    // turn 0: parent calls Subagent · turn 1: the CHILD loop · turn 2: parent concludes using the result.
    const provider = createFakeProvider([
      [toolUse('a1', 'Subagent', { description: 'find X', prompt: 'locate X in the codebase', subagent_type: 'explore' }), done('tool_use')],
      [textDelta('Found X defined in foo.ts:42'), done('end_turn')], // the subagent's own loop, isolated context
      [textDelta('X lives in foo.ts:42.'), done('end_turn')], // parent, after receiving the subagent result
    ])

    const events = await collect(
      runAgentLoop([{ role: 'user', content: 'where is X?' }], {
        provider,
        model: 'fake',
        cwd: tmpdir(),
        signal: new AbortController().signal,
        permission: bypass,
      }),
    )

    // The subagent's final text came back as the Subagent tool_result (only the summary, not its steps).
    const toolResults = events.filter((e) => e.type === 'toolResult') as Extract<ActivityEvent, { type: 'toolResult' }>[]
    expect(toolResults.some((e) => e.preview.includes('Found X defined in foo.ts:42'))).toBe(true)
    // The parent used it to conclude.
    const last = events.filter((e) => e.type === 'message').pop() as Extract<ActivityEvent, { type: 'message' }>
    expect(text(last.message)).toContain('foo.ts:42')
    // The provider was called 3× (parent, child, parent) — proof the child ran its own loop.
    expect(provider.calls.length).toBe(3)
  })
})
