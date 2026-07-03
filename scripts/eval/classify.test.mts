// classify.test.mts — the E4 classifier verified offline on synthetic traces, one per failure class.
// This is what makes the routing table trustworthy: each class has a pinned, minimal signature.

import { describe, expect, it } from 'vitest'
import { classify, parseTrace, type TraceEv } from './classify.mts'

const row = (over: Partial<Parameters<typeof classify>[1]> = {}) => ({ solved: false, timedOut: false, turns: 5, maxTurns: 12, ...over })

// Shorthand builders for trace events.
const call = (name: string, input: unknown = {}): TraceEv => ({ t: 'tool_call', name, input })
const fail = (name: string, content: string): TraceEv => ({ t: 'tool_result', name, ok: false, content })
const okRes = (name: string): TraceEv => ({ t: 'tool_result', name, ok: true, content: 'ok' })
const compaction = (kind = 'summarized'): TraceEv => ({ t: 'compaction', kind, forced: false })

describe('classify — one pinned signature per class', () => {
	it('solved wins regardless of trace content', () => {
		expect(classify([], row({ solved: true })).class).toBe('solved')
	})

	it('no_tool_use: zero tool calls', () => {
		expect(classify([{ t: 'model_response', text: 'here is how you would do it…' }], row()).class).toBe('no_tool_use')
	})

	it('backend_failure: fatal backend error outranks everything (real Ollama-crash signature)', () => {
		const ev: TraceEv[] = [
			{ t: 'error', message: 'recover(transient) attempt 5, wait 8869ms' },
			{ t: 'error', message: '⚠️ The model call kept failing (ollama HTTP 500: llama-server process has terminated: exit status 0xc0000409)' },
		]
		expect(classify(ev, row()).class).toBe('backend_failure')
	})

	it("plain 'recover(' retries alone are NOT a backend failure (retries can succeed)", () => {
		const ev: TraceEv[] = [{ t: 'error', message: 'recover(transient) attempt 1, wait 542ms' }, { t: 'model_response', text: 'prose' }]
		expect(classify(ev, row()).class).toBe('no_tool_use')
	})

	it('bad_tool_name: hallucinated tool', () => {
		const ev = [call('read_file'), fail('read_file', 'No such tool: read_file')]
		expect(classify(ev, row()).class).toBe('bad_tool_name')
	})

	it('invalid_args: ≥2 Zod rejections on the same tool', () => {
		const ev = [call('Edit'), fail('Edit', 'Invalid input for Edit: path required'), call('Edit'), fail('Edit', 'Invalid input for Edit: path required')]
		expect(classify(ev, row()).class).toBe('invalid_args')
	})

	it('one Zod rejection is normal self-correction, not invalid_args', () => {
		const ev = [call('Edit'), fail('Edit', 'Invalid input for Edit: path required'), call('Bash', { command: 'node --test' }), okRes('Bash')]
		expect(classify(ev, row()).class).not.toBe('invalid_args')
	})

	it('edit_mismatch: ≥2 freshness/old_string failures', () => {
		const ev = [call('Edit'), fail('Edit', 'File has not been read yet. Read it first.'), call('Edit'), fail('Edit', 'old_string was not found in the file')]
		expect(classify(ev, row()).class).toBe('edit_mismatch')
	})

	it('context_thrash: ≥3 compactions', () => {
		const ev = [call('Read'), okRes('Read'), compaction(), compaction('masked'), compaction()]
		expect(classify(ev, row()).class).toBe('context_thrash')
	})

	it('context_thrash: overflow recovery counts even once', () => {
		const ev = [call('Read'), okRes('Read'), { t: 'error', message: 'recover(overflow) attempt 1, wait 500ms' }]
		expect(classify(ev, row()).class).toBe('context_thrash')
	})

	it('loop_stall: timed out', () => {
		const ev = [call('Read'), okRes('Read')]
		expect(classify(ev, row({ timedOut: true })).class).toBe('loop_stall')
	})

	it('loop_stall: exhausted maxTurns', () => {
		const ev = [call('Read'), okRes('Read')]
		expect(classify(ev, row({ turns: 12, maxTurns: 12 })).class).toBe('loop_stall')
	})

	it('false_done: finished under budget but never ran the tests', () => {
		const ev = [call('Read'), okRes('Read'), call('Edit'), okRes('Edit')]
		expect(classify(ev, row()).class).toBe('false_done')
	})

	it('wrong_code: edited AND verified, still failing', () => {
		const ev = [call('Read'), okRes('Read'), call('Edit'), okRes('Edit'), call('Bash', { command: 'node --test' }), okRes('Bash')]
		expect(classify(ev, row()).class).toBe('wrong_code')
	})

	it('priority: mechanical failure (bad_tool_name) beats loop_stall even when timed out', () => {
		const ev = [call('nope'), fail('nope', 'No such tool: nope')]
		expect(classify(ev, row({ timedOut: true })).class).toBe('bad_tool_name')
	})
})

describe('parseTrace', () => {
	it('tolerates blank and corrupt lines', () => {
		const events = parseTrace('{"t":"tool_call","name":"Read"}\n\nnot json\n{"t":"turn_done"}')
		expect(events.map((e) => e.t)).toEqual(['tool_call', 'turn_done'])
	})
})
