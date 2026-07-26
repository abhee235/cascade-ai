// ADR-078 — KV-wall-aware deep compaction. Measured motivation (2026-07-25, 131k remote build): four
// compactions freed 0.5–6.5% of the window each (one freed 701 tokens), re-triggered after 21/1/6 responses,
// each costing a 38–45s full re-prefill — and `summarize` (with the ADR-074 curation harvest coupled to it)
// never fired once. Constrained economics: compact rarely, compact DEEP (all layers + unconditional summarize
// down to `deepTarget`), thresholds calculated from live turn growth, thinking excluded from wire estimates.

import { describe, expect, it } from 'vitest'
import { compactIfNeeded, estimateTokens, estimateTokensWithThinking, planCompaction, stripAnalysisBlock, type CompactionPlan } from '../src/context/compactor'
import { constrainedAutoThreshold } from '../src/context/compactionPlan'
import type { Message } from '../src/protocol'
import type { ModelProvider } from '../src/llm/provider'

// ── plan math ────────────────────────────────────────────────────────────────────────────────────────────

describe('planCompaction — economics branch (ADR-078)', () => {
	it('hosted (default) is unchanged: deepTarget collapses to auto, economics=hosted', () => {
		const p = planCompaction({ window: 131072, maxOutputTokens: 16384 })
		expect(p.economics).toBe('hosted')
		expect(p.deepTarget).toBe(p.auto) // the executor's stop threshold degenerates to today's behavior
	})

	it('constrained: deepTarget demands ≥45% of the window free (131k golden)', () => {
		const p = planCompaction({ window: 131072, maxOutputTokens: 16384, economics: 'constrained' })
		expect(p.economics).toBe('constrained')
		expect(p.deepTarget).toBe(Math.floor(131072 * 0.55)) // 72,089 — vs auto 101,688: ~30k deeper per event
		expect(p.deepTarget).toBeLessThan(p.auto)
	})

	it('tiny windows: the floor wins — never target below keepRecent + summary room', () => {
		const p = planCompaction({ window: 8192, economics: 'constrained' })
		expect(p.deepTarget).toBeGreaterThanOrEqual(p.keepRecentTokens)
		expect(p.deepTarget).toBeLessThanOrEqual(p.auto)
	})
})

describe('constrainedAutoThreshold — trigger from LIVE turn growth', () => {
	const p = planCompaction({ window: 131072, maxOutputTokens: 16384, economics: 'constrained' })
	it('at measured-normal growth (1088 tok/turn) it equals the hosted trigger (the fixed headroom dominates)', () => {
		expect(constrainedAutoThreshold(p, 1088)).toBe(p.auto)
	})
	it('a fast-growing session triggers EARLIER (8 turns of 5k growth > the fixed buffer)', () => {
		const t = constrainedAutoThreshold(p, 5000)
		expect(t).toBeLessThan(p.auto)
		expect(t).toBe(131072 - 8 * 5000)
	})
	it('never later than hosted, never below half the window (degenerate-growth clamp)', () => {
		expect(constrainedAutoThreshold(p, 1)).toBeLessThanOrEqual(p.auto)
		expect(constrainedAutoThreshold(p, 1_000_000)).toBe(Math.floor(131072 / 2))
	})
})

// ── wire-accurate estimates (rung 1b) ────────────────────────────────────────────────────────────────────

describe('estimateTokens — thinking is phantom (never replayed on any wire path)', () => {
	const msgs: Message[] = [
		{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(4000) }, { type: 'text', text: 'y'.repeat(400) }] },
	]
	it('excludes thinking from the wire estimate', () => {
		expect(estimateTokens(msgs)).toBe(100) // 400 chars text only
	})
	it('estimateTokensWithThinking includes it (summarize-input sizing)', () => {
		expect(estimateTokensWithThinking(msgs)).toBe(1100)
	})
})

describe('stripAnalysisBlock — scratchpad stripped, but a swallowed summary is SALVAGED', () => {
	it('strips a closed block when a real summary follows', () => {
		expect(stripAnalysisBlock('<analysis>draft chaos</analysis>REAL SUMMARY')).toBe('REAL SUMMARY')
	})
	it('SALVAGE: everything-inside-the-block returns the inner content (measured: 2/2 live summaries silently dropped)', () => {
		expect(stripAnalysisBlock('<analysis>the whole summary lives here</analysis>')).toBe('the whole summary lives here')
	})
	it('SALVAGE: an unterminated block returns its draft instead of empty', () => {
		expect(stripAnalysisBlock('<analysis>model ran out mid-draft')).toBe('model ran out mid-draft')
	})
})

// ── executor behavior ────────────────────────────────────────────────────────────────────────────────────

/** Synthetic plan: auto 800, deepTarget 550 — sized so the mask layer alone satisfies HOSTED but not DEEP. */
const constrainedPlan = (): CompactionPlan => ({
	window: 1000,
	effectiveWindow: 1000,
	warn: 600,
	auto: 800,
	hard: 970,
	keepRecentTokens: 100,
	keepRecentResults: 1,
	toolResultMaxChars: 500,
	layers: new Set(['mask', 'summarize']),
	mode: 'layered',
	economics: 'constrained',
	deepTarget: 550,
	tier: 'full',
})
const hostedPlan = (): CompactionPlan => ({ ...constrainedPlan(), economics: 'hosted', deepTarget: 800 })

/** History ≈890 tok. Older region: big task text + assistant + a maskable 800-char Bash result (NOT shielded:
 *  the recency shield protects the newer Read below instead). Recent tail: a shielded Read + small texts. */
const history = (): Message[] => [
	{ role: 'user', content: 'T'.repeat(1200) },
	{ role: 'assistant', content: 'A'.repeat(1200) },
	{ role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] },
	{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'R'.repeat(800) }] },
	{ role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'z.ts' } }] },
	{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'S'.repeat(80) }] },
	{ role: 'assistant', content: 'B'.repeat(200) },
	{ role: 'user', content: 'latest small instruction' },
]

const summarizer = (text: string, log?: string[]): ModelProvider =>
	({
		id: 'fake',
		complete: async () => {
			log?.push('call')
			return { text }
		},
	}) as unknown as ModelProvider

const failing = (log: string[]): ModelProvider =>
	({
		id: 'fake',
		complete: async () => {
			log.push('call')
			throw new Error('summarizer down')
		},
	}) as unknown as ModelProvider

describe('compactIfNeeded — constrained runs DEEP where hosted stops early (the 701-token fix)', () => {
	it('hosted: mask gets under auto → stops, summarize never paid (today, byte-for-byte)', async () => {
		const r = await compactIfNeeded(history(), { provider: summarizer('S'), model: 'm', plan: hostedPlan() })
		expect(r.kind).toBe('masked')
	})

	it('constrained: same input pushes past auto down to deepTarget via summarize, scratchpad stripped', async () => {
		const r = await compactIfNeeded(history(), {
			provider: summarizer('<analysis>chronological draft</analysis>FILE LEDGER: src/a.ts — the thing'),
			model: 'm',
			plan: constrainedPlan(),
		})
		expect(r.kind).toBe('summarized')
		expect(estimateTokens(r.messages)).toBeLessThan(550) // hit the deep target, not just auto
		const head = typeof r.messages[0]!.content === 'string' ? (r.messages[0]!.content as string) : ''
		expect(head).toContain('FILE LEDGER')
		expect(head).not.toContain('<analysis>') // drafting scratchpad never enters history
		expect(head).toContain('Trust the FILE LEDGER') // re-read-storm guidance rides along
		expect(head).toContain('[Original task]') // verbatim task preserved outside the summary, as before
	})

	it('under the trigger nothing happens (deep mode must not compact eagerly)', async () => {
		const small: Message[] = [{ role: 'user', content: 'tiny' }]
		const r = await compactIfNeeded(small, { provider: summarizer('S'), model: 'm', plan: constrainedPlan() })
		expect(r.kind).toBe('none')
	})
})

describe('compactIfNeeded — summarize circuit breaker (3 strikes, resets on success)', () => {
	it('3 consecutive failures → the 4th event stops paying the dead side-query', async () => {
		const plan = constrainedPlan()
		plan.layers = new Set(['summarize']) // no cheap relief — every event reaches the summarize path
		const calls: string[] = []
		const deps = { provider: failing(calls), model: 'm', plan, sleepForTest: async () => {} }
		for (let i = 0; i < 3; i++) {
			const r = await compactIfNeeded(history(), deps)
			expect(r.kind).toBe('dropped') // summary unavailable → lossy-drop fallback, window still freed
		}
		const callsAfter3 = calls.length
		const r4 = await compactIfNeeded(history(), deps)
		expect(r4.kind).toBe('none') // breaker tripped: no side-query, no drop — cheap state stands
		expect(calls.length).toBe(callsAfter3) // the summarizer was NOT called again
	})

	it('a success resets the breaker', async () => {
		const plan = constrainedPlan()
		const ok: string[] = []
		const r = await compactIfNeeded(history(), { provider: summarizer('GOOD', ok), model: 'm', plan })
		expect(r.kind).toBe('summarized')
		expect(ok.length).toBe(1)
	})
})

describe('summarize input is BOUNDED (cold-resume edge: restored history >> current window)', () => {
	it('an oversized older region reaches the summarizer elided head+tail, never raw', async () => {
		const plan = constrainedPlan() // effectiveWindow 1000 → budget ≈ max(8000, …) = 8000 chars
		let seen = ''
		const provider = {
			id: 'fake',
			complete: async (req: { messages: { content: string }[] }) => {
				seen = String(req.messages[0]!.content)
				return { text: 'S' }
			},
		} as unknown as ModelProvider
		const huge: Message[] = [
			{ role: 'user', content: 'task '.repeat(4000) }, // ~20k chars — dwarfs the 1k-token window
			{ role: 'assistant', content: 'work '.repeat(4000) },
			{ role: 'assistant', content: 'tail-anchor' },
			{ role: 'user', content: 'recent' },
		]
		const r = await compactIfNeeded(huge, { provider, model: 'm', plan })
		expect(r.kind).toBe('summarized')
		expect(seen.length).toBeLessThanOrEqual(8200) // bounded (budget + marker slack)
		expect(seen).toContain('middle of the conversation omitted')
		expect(seen.startsWith('USER: task')).toBe(true) // head kept
	})
})
