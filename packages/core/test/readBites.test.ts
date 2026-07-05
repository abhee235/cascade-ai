// ADR-052 — window-aware Read bites. The measured failure: on an 8k window a single "legal" 19k-char read
// overflowed the whole window; the compactor amputated it; the model re-read; repeat until the clock died
// (every longctx failure opened this way; final signature: input 8191/8192 + ONE output token). One bite
// must never exceed the plate — and the refusal must TEACH the exact next call.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadTool } from '../src/tools/builtins/Read'
import type { ToolContext } from '../src/tools/Tool'

const dir = mkdtempSync(join(tmpdir(), 'readbites-'))
const bigFile = join(dir, 'CHANGELOG.md')
writeFileSync(bigFile, Array.from({ length: 400 }, (_, i) => `## entry ${i} ${'x'.repeat(40)}`).join('\n')) // ~19k chars

const ctx = (readCapChars?: number): ToolContext => ({ cwd: dir, abortSignal: new AbortController().signal, readCapChars })

describe('ADR-052 — window-aware Read bites', () => {
	it('small window: a whole-file read over the cap is refused with a TEACHING error', async () => {
		const r = await ReadTool.call({ file_path: 'CHANGELOG.md' }, ctx(6_000))
		expect(r.isError).toBe(true)
		expect(r.content).toMatch(/offset: 1, limit: \d+/) // hands the model the exact next call
		expect(r.content).toContain('then continue with offset:') // and the one after
		expect(r.content).toContain('Subagent') // and the delegation path for bulk work
	})

	it('the suggested window actually fits under the cap', async () => {
		const r = await ReadTool.call({ file_path: 'CHANGELOG.md' }, ctx(6_000))
		const limit = Number(/limit: (\d+)/.exec(r.content)![1])
		const follow = await ReadTool.call({ file_path: 'CHANGELOG.md', offset: 1, limit }, ctx(6_000))
		expect(follow.isError).toBeFalsy()
		expect(follow.content.length).toBeLessThanOrEqual(6_000 * 1.2)
	})

	it('an explicit offset/limit that would still overflow is refused too (no silent truncation)', async () => {
		const r = await ReadTool.call({ file_path: 'CHANGELOG.md', offset: 1, limit: 400 }, ctx(6_000))
		expect(r.isError).toBe(true)
		expect(r.content).toContain('more than fits')
	})

	it('big window (no cap injected): behavior unchanged — the whole 19k file reads fine', async () => {
		const r = await ReadTool.call({ file_path: 'CHANGELOG.md' }, ctx())
		expect(r.isError).toBeFalsy()
		expect(r.content).toContain('entry 399') // complete
	})
})
