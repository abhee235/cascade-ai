import { describe, it, expect } from 'vitest'
import { classifyError, streamWithRecovery, RecoveryError } from '../src/llm/resilience'
import type { StreamEvent } from '../src/llm/provider'

const err = (props: Record<string, unknown>) => Object.assign(new Error((props.message as string) ?? 'x'), props)
async function drain(gen: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}
const noSleep = async () => {}

describe('classifyError (the retry taxonomy)', () => {
  it('abort / overflow / transient / fatal', () => {
    expect(classifyError(err({ name: 'AbortError' }))).toBe('abort')
    expect(classifyError(new Error('context length exceeded'))).toBe('overflow')
    expect(classifyError(new Error('num_ctx too long'))).toBe('overflow')
    expect(classifyError(err({ code: 'ECONNREFUSED' }))).toBe('transient')
    expect(classifyError(err({ status: 429 }))).toBe('transient')
    expect(classifyError(err({ status: 503 }))).toBe('transient')
    expect(classifyError(err({ status: 400 }))).toBe('fatal') // deterministic
    expect(classifyError(err({ status: 401 }))).toBe('fatal')
    expect(classifyError(err({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }))).toBe('transient')
    // The "terminated" case from the bug report: undici drops a streaming connection mid-response.
    expect(classifyError(err({ name: 'TypeError', message: 'terminated', cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }))).toBe('transient')
    expect(classifyError(new Error('terminated'))).toBe('transient')
    expect(classifyError(err({ code: 'UND_ERR_SOCKET' }))).toBe('transient')
  })
})

// A provider stream that throws on the first `failTimes` attempts, then yields a normal turn.
function flaky(failTimes: number, error: unknown) {
  let calls = 0
  const make = () =>
    (async function* () {
      calls++
      if (calls <= failTimes) throw error
      yield { type: 'text_delta', text: 'ok' } as StreamEvent
      yield { type: 'done', stopReason: 'end_turn' } as StreamEvent
    })()
  return { make, calls: () => calls }
}

describe('streamWithRecovery', () => {
  it('retries transient failures with backoff, then succeeds', async () => {
    const f = flaky(2, err({ code: 'ECONNREFUSED' }))
    const out = await drain(streamWithRecovery(f.make, { sleep: noSleep, maxRetries: 4 }))
    expect(f.calls()).toBe(3)
    expect(out.some((e) => e.type === 'text_delta')).toBe(true)
  })

  it('gives up after maxRetries → RecoveryError', async () => {
    const f = flaky(99, err({ code: 'ECONNREFUSED' }))
    await expect(drain(streamWithRecovery(f.make, { sleep: noSleep, maxRetries: 2 }))).rejects.toBeInstanceOf(RecoveryError)
    expect(f.calls()).toBe(3) // 1 + 2 retries
  })

  it('fatal errors fail fast (no retry)', async () => {
    const f = flaky(99, err({ status: 400 }))
    await expect(drain(streamWithRecovery(f.make, { sleep: noSleep }))).rejects.toBeInstanceOf(RecoveryError)
    expect(f.calls()).toBe(1)
  })

  it('abort is rethrown immediately (not wrapped)', async () => {
    const f = flaky(99, err({ name: 'AbortError', message: 'cancelled' }))
    await expect(drain(streamWithRecovery(f.make, { sleep: noSleep }))).rejects.toThrow(/cancelled/)
    expect(f.calls()).toBe(1)
  })

  it('overflow → runs onOverflow (compact) then retries', async () => {
    let compacted = 0
    const f = flaky(1, new Error('context window exceeded'))
    await drain(streamWithRecovery(f.make, { sleep: noSleep, onOverflow: async () => void compacted++ }))
    expect(compacted).toBe(1)
    expect(f.calls()).toBe(2)
  })

  it('overflow that never shrinks → RecoveryError after the cap', async () => {
    const f = flaky(99, new Error('num_ctx exceeded'))
    await expect(
      drain(streamWithRecovery(f.make, { sleep: noSleep, onOverflow: async () => {}, maxOverflowRetries: 2 })),
    ).rejects.toBeInstanceOf(RecoveryError)
    expect(f.calls()).toBe(3) // 1 + 2 overflow retries
  })
})
