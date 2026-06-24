import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { BashTool } from '../src/tools/builtins/Bash'
import { scheduleTools } from '../src/tools/scheduler'
import type { ToolContext } from '../src/tools/Tool'
import type { ActivityEvent, ContentBlock } from '../src/protocol'

const ctx = (): ToolContext => ({ cwd: tmpdir(), abortSignal: new AbortController().signal })

async function drain(gen: AsyncGenerator<ActivityEvent, ContentBlock[]>) {
  const events: ActivityEvent[] = []
  let r = await gen.next()
  while (!r.done) {
    events.push(r.value)
    r = await gen.next()
  }
  return { events, result: r.value }
}

describe('BashTool', () => {
  it('runs a command and returns its output, streaming chunks via onProgress', async () => {
    const chunks: string[] = []
    const result = await BashTool.call({ command: 'echo cascade-bash-ok' }, ctx(), (c) => chunks.push(c))
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('cascade-bash-ok')
    expect(chunks.join('')).toContain('cascade-bash-ok') // progress was streamed, not just returned at the end
  })

  it('flags a nonzero exit as an error (so the model can self-correct)', async () => {
    const result = await BashTool.call({ command: 'exit 3' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('[exit 3]')
  })

  it('input-dependent read-only: ls/cat are read-only & concurrency-safe; rm is not', () => {
    expect(BashTool.isReadOnly?.({ command: 'ls -la' })).toBe(true)
    expect(BashTool.isReadOnly?.({ command: 'cat a | grep b' })).toBe(true)
    expect(BashTool.isConcurrencySafe?.({ command: 'git status' })).toBe(true)
    expect(BashTool.isReadOnly?.({ command: 'rm -rf x' })).toBe(false)
    expect(BashTool.isReadOnly?.({ command: 'ls && rm x' })).toBe(false) // any unsafe segment ⇒ not read-only
  })

  it('streams toolProgress through the scheduler, in order: toolStart → toolProgress → toolResult', async () => {
    const tu = { id: 'b1', name: 'Bash', input: { command: 'echo scheduler-progress' } }
    const { events, result } = await drain(scheduleTools([tu], ctx()))
    const types = events.map((e) => e.type)
    expect(types.indexOf('toolStart')).toBeLessThan(types.indexOf('toolProgress'))
    expect(types.indexOf('toolProgress')).toBeLessThan(types.indexOf('toolResult'))
    const prog = events.filter((e) => e.type === 'toolProgress') as Extract<ActivityEvent, { type: 'toolProgress' }>[]
    expect(prog.map((p) => p.chunk).join('')).toContain('scheduler-progress')
    expect((result[0] as any).isError).toBeFalsy()
  })

  it('kills the child when the signal aborts', async () => {
    const ac = new AbortController()
    const ctxAbort: ToolContext = { cwd: tmpdir(), abortSignal: ac.signal }
    // A command that would run for a while; abort almost immediately.
    const p = BashTool.call({ command: 'node -e "setTimeout(()=>{},10000)"' }, ctxAbort)
    setTimeout(() => ac.abort(), 50)
    const result = await p
    expect(result.isError).toBe(true)
    expect(result.content).toContain('[aborted]')
  })
})
