import { describe, it, expect } from 'vitest'
import { toOpenAIMessages } from '../src/llm/providers/openaiCompat'
import type { Message } from '../src/protocol'

describe('toOpenAIMessages (the bridge)', () => {
  it('prepends the system prompt', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }], 'SYS')
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('assistant tool_use → tool_calls with JSON-stringified args', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a' } }] },
    ]
    const out: any = toOpenAIMessages(msgs)
    expect(out[0].role).toBe('assistant')
    expect(out[0].content).toBe('ok')
    expect(out[0].tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'Read' } })
    expect(JSON.parse(out[0].tool_calls[0].function.arguments)).toEqual({ file_path: 'a' })
  })

  it('user tool_result → role:tool message keyed by tool_use_id', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'RESULT' }] }]
    const out = toOpenAIMessages(msgs)
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'RESULT' })
  })
})
