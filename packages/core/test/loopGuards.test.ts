// Streaming-loop guards (2026-07-26 incidents): the degeneration detector (186s of '@@@@…' thinking before
// the user killed the turn) and stale-image eviction (prefill 29s → 127–137s once screenshots sat in history).

import { describe, expect, it } from 'vitest'
import { evictStaleImages, isDegenerateTail } from '../src/agent/agentLoop'
import type { Message } from '../src/protocol'

describe('isDegenerateTail — repeated-token collapse detector', () => {
	it('fires on a long single-character run (the @@@@ incident)', () => {
		expect(isDegenerateTail('let me think about this. ' + '@'.repeat(500))).toBe(true)
	})
	it('fires on two-character padding collapse', () => {
		expect(isDegenerateTail('x'.repeat(100) + ' . . . . '.repeat(60))).toBe(true) // ≤2 distinct in the window
	})
	it('does NOT fire on ASCII game-board art (3-4 distinct, short runs — the game-dev false-positive audit)', () => {
		const board = ('█░█░█░█░██░░██' + String.fromCharCode(10)).repeat(40)
		expect(isDegenerateTail(board)).toBe(false)
	})
	it('never fires on legitimate prose or code', () => {
		const prose = 'The component mounts, allocates a renderer, and subscribes to resize events. '.repeat(10)
		expect(isDegenerateTail(prose)).toBe(false)
		const code = 'const x = { a: 1, b: 2 }; function f(y) { return y * 2 } '.repeat(20)
		expect(isDegenerateTail(code)).toBe(false)
	})
	it('stays quiet below the window (short outputs never flagged)', () => {
		expect(isDegenerateTail('@@@@@@@@')).toBe(false)
	})
})

describe('evictStaleImages — only the newest screenshot stays hot', () => {
	const img = (n: number): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + n, content: 'looked at it' }, { type: 'image', url: 'data:image/jpeg;base64,AAA' + n }] })
	const userUpload = (): Message => ({ role: 'user', content: [{ type: 'text', text: 'make it look like this' }, { type: 'image', url: 'data:image/png;base64,REF' }] })
	it('replaces all but the latest image with placeholders; text results survive verbatim', () => {
		const msgs: Message[] = [img(1), { role: 'assistant', content: 'judged it' }, img(2), { role: 'assistant', content: 'ok' }]
		evictStaleImages(msgs)
		const c0 = msgs[0]!.content as Extract<Message['content'], unknown[]>
		expect(c0.some((b: { type: string }) => b.type === 'image')).toBe(false)
		expect(JSON.stringify(c0)).toContain('screenshot evicted')
		expect(JSON.stringify(c0)).toContain('looked at it') // the judgment text survives
		const c2 = msgs[2]!.content as Extract<Message['content'], unknown[]>
		expect(c2.some((b: { type: string }) => b.type === 'image')).toBe(true) // newest stays
	})
	it('no images → untouched', () => {
		const msgs: Message[] = [{ role: 'user', content: 'hi' }]
		evictStaleImages(msgs)
		expect(msgs[0]!.content).toBe('hi')
	})

	it('NEVER evicts user-uploaded reference images (the replicate-this-design flow)', () => {
		const msgs: Message[] = [userUpload(), { role: 'assistant', content: 'on it' }, img(1), { role: 'assistant', content: 'ok' }, img(2)]
		evictStaleImages(msgs)
		const ref = msgs[0]!.content as Extract<Message['content'], unknown[]>
		expect(ref.some((b: { type: string }) => b.type === 'image')).toBe(true) // reference survives forever
		const c2 = msgs[2]!.content as Extract<Message['content'], unknown[]>
		expect(c2.some((b: { type: string }) => b.type === 'image')).toBe(false) // old screenshot evicted
	})
})
