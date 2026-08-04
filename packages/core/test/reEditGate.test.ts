// ADR-072 — the RE-EDIT breaker. Corpus motivation (22 builds, 2026-07-24): a file edited ≥5× in 55% of
// builds; the model thrashes a file whose problem-source lives elsewhere (Velocarta: CTA colour fixed at the
// call site 3× while it came from the theme). The gate counts per-file edits and, at the threshold, points the
// model at Grep/Lsp to trace the real source.

import { describe, expect, it } from 'vitest'
import { buildReEditNudge, foldReEdit, REEDIT_THRESHOLD } from '../src/agent/reEditGate'
import type { ContentBlock } from '../src/protocol'
import type { ToolUse } from '../src/tools/runTool'

const ok = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
const edit = (id: string, path: string, name = 'Edit'): ToolUse => ({ id, name, input: { file_path: path, old_string: 'x', new_string: 'y' } })

describe('foldReEdit — unit', () => {
  it(`reports the ${REEDIT_THRESHOLD}th same-file edit crossing exactly once`, () => {
    const counts = new Map<string, number>()
    for (let i = 1; i < REEDIT_THRESHOLD; i++) expect(foldReEdit(counts, [edit(String(i), 'Home.tsx')], [ok(String(i))])).toEqual([])
    expect(foldReEdit(counts, [edit(String(REEDIT_THRESHOLD), 'Home.tsx')], [ok(String(REEDIT_THRESHOLD))])).toEqual(['Home.tsx'])
    // one past the threshold: already fired, no re-fire
    expect(foldReEdit(counts, [edit('x', 'Home.tsx')], [ok('x')])).toEqual([])
  })

  it('counts Write and MultiEdit too, and keys per file (interleaved edits to different files don’t trip)', () => {
    const counts = new Map<string, number>()
    let fired: string[] = []
    for (let i = 0; i < REEDIT_THRESHOLD; i++) {
      fired = fired.concat(foldReEdit(counts, [edit('a' + i, 'A.tsx'), edit('b' + i, 'B.tsx', 'Write')], [ok('a' + i), ok('b' + i)]))
    }
    // both A and B reach the threshold on the same batch — both reported (each once)
    expect(fired.filter((f) => f === 'A.tsx').length).toBe(1)
    expect(fired.filter((f) => f === 'B.tsx').length).toBe(1)
  })

  it('a FAILED edit does not move the counter', () => {
    const counts = new Map<string, number>()
    const err: ContentBlock = { type: 'tool_result', tool_use_id: 'e', content: 'no match', isError: true }
    for (let i = 0; i < REEDIT_THRESHOLD + 2; i++) foldReEdit(counts, [edit('e', 'A.tsx')], [err])
    expect(counts.get('A.tsx') ?? 0).toBe(0) // all failed → never fires
  })
})

// ── Escalation (FocusFlow, 2026-07-30) ───────────────────────────────────────────────────────────────
// The one-shot advisory at 6 was IGNORED: setupTests.ts reached 7 edits, vitest.config.ts 4, package.json 4
// — all rewriting a config that was never broken (the real fault was a shell-corrupted test file). The gate
// now fires at 5 and RE-FIRES every 3 further edits, with a directive second message.
describe('re-edit escalation', () => {
	const ok = (id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })
	const edit = (id: string, path: string) => ({ id, name: 'Edit', input: { file_path: path } })

	it('fires at the threshold, then every 3 edits after it', () => {
		const counts = new Map<string, number>()
		const fired: number[] = []
		for (let i = 1; i <= 12; i++) {
			const crossed = foldReEdit(counts, [edit(`t${i}`, 'a.ts')] as never, [ok(`t${i}`)] as never)
			if (crossed.length) fired.push(i)
		}
		expect(fired).toEqual([5, 8, 11]) // was [6] only — a single note the model could ignore
	})

	it('the first nudge is advisory; the escalated one forbids further edits until the diagnosis is checked', () => {
		const first = buildReEditNudge('a.ts', 5)
		expect(first).toContain('If these edits are genuine separate improvements, ignore this')
		const escalated = buildReEditNudge('a.ts', 8)
		expect(escalated).toContain('STOP editing')
		expect(escalated).toContain('your DIAGNOSIS is wrong')
		expect(escalated).toContain('If the error names a different file, fix THAT file')
	})
})
