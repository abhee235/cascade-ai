// ADR-058 — the UNCONSUMED-READ shield. The flat last-N recency shield protects "the newest results"; this
// protects "the read the model has not acted on yet". Measured motivation (Simmer live-lock): the model read
// types.ts, narrated for two turns, compaction masked the read, it re-read — five times, across 33 turns,
// with zero edits, because the read→act latency of a weak model is LONGER than the masking cadence at 32k.

import { describe, expect, it } from 'vitest'
import { compactIfNeeded, unconsumedReadIds, type CompactionPlan } from '../src/context/compactor'
import type { Message } from '../src/protocol'

const use = (id: string, name: string, path: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: path } }] })
const result = (id: string, content: string, isError = false): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, isError }] })

describe('unconsumedReadIds — unit', () => {
	it('shields the latest read of a file NOT written since; a mutation consumes it', () => {
		const msgs: Message[] = [
			use('ra', 'Read', 'src/a.ts'),
			result('ra', 'a-content'),
			use('rb', 'Read', 'src/b.ts'),
			result('rb', 'b-content'),
			use('wb', 'Write', 'src/b.ts'),
			result('wb', 'ok'),
		]
		const ids = unconsumedReadIds(msgs)
		expect(ids.has('ra')).toBe(true) // read, never acted on — the working set
		expect(ids.has('rb')).toBe(false) // consumed by the Write — the healthy cycle
	})

	it('errored reads never occupy a shield slot', () => {
		const msgs: Message[] = [use('re', 'Read', 'src/missing.ts'), result('re', 'no such file', true)]
		expect(unconsumedReadIds(msgs).size).toBe(0)
	})

	it('caps at the most recent N unconsumed files (pressure must stay reclaimable)', () => {
		const msgs: Message[] = []
		for (let i = 0; i < 5; i++) {
			msgs.push(use(`r${i}`, 'Read', `src/f${i}.ts`), result(`r${i}`, `content-${i}`))
		}
		const ids = unconsumedReadIds(msgs, 3)
		expect(ids.size).toBe(3)
		expect(ids.has('r4')).toBe(true) // newest kept…
		expect(ids.has('r0')).toBe(false) // …oldest dropped
	})

	it('horizon-bounded: a reference file read long ago must not block compaction forever', () => {
		const msgs: Message[] = [use('old', 'Read', 'src/photos.ts'), result('old', 'reference content')]
		for (let i = 0; i < 20; i++) msgs.push({ role: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] })
		expect(unconsumedReadIds(msgs, 3, 16).has('old')).toBe(false)
	})
})

// Between auto and the ceiling (non-survival): masking must skip the unconsumed read.
const roomyPlan: CompactionPlan = {
	window: 10_000,
	effectiveWindow: 9_000,
	warn: 60,
	auto: 100,
	hard: 9_500,
	keepRecentTokens: 25,
	keepRecentResults: 1,
	toolResultMaxChars: 200,
	layers: new Set(['mask']),
	mode: 'layered',
	tier: 'full',
}

const bigMsgs = (): Message[] => [
	use('ra', 'Read', 'src/a.ts'),
	result('ra', 'A'.repeat(2000)), // unconsumed read — must survive masking
	use('b1', 'Bash', 'x'),
	result('b1', 'B'.repeat(2000)), // plain old observation — maskable
	use('b2', 'Bash', 'y'),
	result('b2', 'C'.repeat(2000)), // the flat shield (keepRecentResults 1) covers only this, the last result
]

describe('unconsumed-read shield — through compactIfNeeded', () => {
	it('masking evicts old observations but NOT the unconsumed read', async () => {
		const msgs = bigMsgs()
		const { messages: out, kind } = await compactIfNeeded(msgs, { provider: { id: 'x', complete: async () => ({ text: '' }), stream: async function* () {} } as never, model: 'fake', plan: roomyPlan })
		expect(kind).toBe('masked')
		const flat = JSON.stringify(out)
		expect(flat).toContain('A'.repeat(2000)) // the read the model has not acted on — intact
		expect(flat).not.toContain('B'.repeat(2000)) // the old observation — evicted
	})

	it('SURVIVAL mode drops the courtesy: over the ceiling the unconsumed read is maskable again', async () => {
		const tightPlan: CompactionPlan = { ...roomyPlan, window: 100, effectiveWindow: 100, hard: 97 } // usage ≥ ceiling
		const msgs = bigMsgs()
		const { messages: out } = await compactIfNeeded(msgs, { provider: { id: 'x', complete: async () => ({ text: '' }), stream: async function* () {} } as never, model: 'fake', plan: tightPlan })
		expect(JSON.stringify(out)).not.toContain('A'.repeat(2000)) // survival beats recency — window first
	})
})
