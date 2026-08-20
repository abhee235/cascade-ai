// Item 4b — whitespace-tolerant edit matching. The measured failure (edit_mismatch class): weak models
// reproduce the CODE of old_string but not its WHITESPACE (tabs retyped as spaces, wrong indent depth), the
// exact matcher says "not found", and the model retries near-identical calls until the budget dies. The
// tolerant matcher is conservative by contract: trimmed matches must be UNIQUE, the replaced region is the
// FILE's own bytes, and new_string's indentation is remapped onto the file's real indent.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findEditTarget } from '../src/tools/editCore'
import { EditTool } from '../src/tools/builtins/Edit'
import { MultiEditTool } from '../src/tools/builtins/MultiEdit'
import type { ToolContext } from '../src/tools/Tool'

const FILE = ['function add(a, b) {', '\tif (a === 0) {', '\t\treturn b', '\t}', '\treturn a + b', '}'].join('\n')

describe('findEditTarget — the matcher ladder', () => {
	it('exact match is untouched (via exact, byte-identical semantics)', () => {
		const t = findEditTarget(FILE, '\treturn a + b', 'X')
		expect(t).toEqual({ ok: true, actual: '\treturn a + b', newString: 'X', via: 'exact' })
	})

	it('exact ambiguity still errors (contract unchanged)', () => {
		const t = findEditTarget('x\nx\n', 'x', 'y')
		expect(t.ok).toBe(false)
		if (!t.ok) expect(t.reason).toBe('not-unique')
	})

	it('tabs retyped as spaces: matches the file, replaces the FILE bytes, remaps new_string indent', () => {
		// The model read tab-indented code but retyped it with 4 spaces — the dominant edit_mismatch shape.
		const t = findEditTarget(FILE, '    if (a === 0) {\n        return b\n    }', '    if (a === 0) {\n        return -1\n    }')
		expect(t.ok).toBe(true)
		if (t.ok) {
			expect(t.via).toBe('trimmed')
			expect(t.actual).toBe('\tif (a === 0) {\n\t\treturn b\n\t}') // the file's own bytes get replaced
			expect(t.newString).toBe('\tif (a === 0) {\n\t\treturn -1\n\t}') // new_string re-indented in file style
		}
	})

	it('unindented old_string that IS a substring stays an exact hit (file indent untouched by replace)', () => {
		// 'return a + b' exists inside '\treturn a + b' — exact substring semantics already handle this; the
		// tolerant ladder must not fire and must not touch the surrounding tab.
		const t = findEditTarget(FILE, 'return a + b', 'return a * b')
		expect(t).toEqual({ ok: true, actual: 'return a + b', newString: 'return a * b', via: 'exact' })
	})

	it('trimmed ambiguity errors instead of guessing', () => {
		// Model whitespace differs (2 spaces vs the file's tab), so exact finds nothing — and the trimmed
		// match hits BOTH lines: refuse rather than pick one.
		const file = '\tdone(1)\n\tdone(1)\n'
		const t = findEditTarget(file, '  done(1)', '  finish(1)')
		expect(t.ok).toBe(false)
		if (!t.ok) expect(t.message).toContain('ignoring indentation')
	})

	it('genuinely absent content: not-found with a re-Read directive; near-miss names the similar line', () => {
		const missing = findEditTarget(FILE, 'while (true) { spin() }', 'x')
		expect(missing.ok).toBe(false)
		if (!missing.ok) expect(missing.message).toContain('Re-Read')
		// One line exists but surroundings are wrong → the hint points at it.
		const near = findEditTarget(FILE, 'return a + b\nconsole.log(a)', 'x')
		expect(near.ok).toBe(false)
		if (!near.ok) expect(near.message).toContain('Line 5')
	})

	it('near-miss echoes the file snippet so the model can rebuild old_string without a Read', () => {
		const near = findEditTarget(FILE, 'return a + b\nconsole.log(a)', 'x')
		expect(near.ok).toBe(false)
		if (!near.ok) {
			expect(near.message).toContain('return a + b') // the file's real line, verbatim
			expect(near.message).toContain('actually reads')
		}
	})

	it('rung 3: model DROPPED the blank line the file has — matches, replaced region keeps the file blank', () => {
		const file = ['function a() {}', '', 'function b() {', '\treturn 1', '}'].join('\n')
		const t = findEditTarget(file, 'function a() {}\nfunction b() {', 'function a2() {}\nfunction b() {')
		expect(t.ok).toBe(true)
		if (t.ok) {
			expect(t.via).toBe('blanks')
			expect(t.actual).toBe('function a() {}\n\nfunction b() {') // the FILE's span, its blank included
		}
	})

	it('rung 3: model INVENTED a blank line the file lacks — still matches', () => {
		const file = ['a()', 'b()', 'c()'].join('\n')
		const t = findEditTarget(file, 'a()\n\nb()', 'a()\nb2()')
		expect(t.ok).toBe(true)
		if (t.ok) expect(t.actual).toBe('a()\nb()')
	})

	it('rung 3 remaps indentation from the paired non-blank file lines', () => {
		const file = ['\tone()', '', '\ttwo()'].join('\n')
		const t = findEditTarget(file, '    one()\n    two()', '    one()\n    three()')
		expect(t.ok).toBe(true)
		if (t.ok) expect(t.newString).toBe('\tone()\n\tthree()') // file's tabs, not the model's spaces
	})

	it('rung 3 ambiguity refuses to guess, naming blank-line tolerance', () => {
		const file = ['x()', '', 'y()', '', 'x()', '', 'y()'].join('\n')
		const t = findEditTarget(file, 'x()\ny()', 'z()')
		expect(t.ok).toBe(false)
		if (!t.ok) {
			expect(t.reason).toBe('not-unique')
			expect(t.message).toContain('blank lines')
		}
	})

	it('exact ambiguity message teaches the replace_all recovery', () => {
		const t = findEditTarget('x\nx\n', 'x', 'y')
		expect(t.ok).toBe(false)
		if (!t.ok) expect(t.message).toContain('replace_all')
	})
})

describe('through the real tools (temp files, freshness-free ctx)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'editmatch-'))
	const ctx: ToolContext = { cwd: dir, abortSignal: new AbortController().signal }

	it('Edit: space-indented old_string fixes a tab-indented file, keeping tabs', async () => {
		writeFileSync(join(dir, 'a.js'), FILE)
		const r = await EditTool.call(
			{ file_path: 'a.js', old_string: '    return a + b', new_string: '    return a - b' },
			ctx,
		)
		expect(r.isError).toBeFalsy()
		expect(r.content).toContain('whitespace tolerance')
		expect(readFileSync(join(dir, 'a.js'), 'utf8')).toContain('\treturn a - b') // file style preserved
	})

	it('MultiEdit: tolerant per-edit, but replace_all stays exact-only', async () => {
		writeFileSync(join(dir, 'b.js'), FILE)
		const ok = await MultiEditTool.call(
			{ file_path: 'b.js', edits: [{ old_string: '  return a + b', new_string: '  return a + b + 1' }] },
			ctx,
		)
		expect(ok.isError).toBeFalsy()
		expect(readFileSync(join(dir, 'b.js'), 'utf8')).toContain('\treturn a + b + 1')

		const ra = await MultiEditTool.call(
			{ file_path: 'b.js', edits: [{ old_string: '    return b', new_string: 'X', replace_all: true }] },
			ctx,
		)
		expect(ra.isError).toBe(true) // exact-only for replace_all: 4-space indent does not exist in the file
	})

	it('Edit: a CRLF file keeps CRLF on disk, and a SECOND edit still passes the freshness guard', async () => {
		const crlf = FILE.replace(/\n/g, '\r\n')
		writeFileSync(join(dir, 'c.js'), crlf)
		const r1 = await EditTool.call({ file_path: 'c.js', old_string: 'return a + b', new_string: 'return a * b' }, ctx)
		expect(r1.isError).toBeFalsy()
		const disk1 = readFileSync(join(dir, 'c.js'), 'utf8')
		expect(disk1).toContain('\r\n') // endings preserved — not flipped wholesale to LF
		expect(disk1).toContain('return a * b')
		// Chained edit: the freshness cache (LF-normalized) must agree with the CRLF bytes on disk.
		const r2 = await EditTool.call({ file_path: 'c.js', old_string: 'return a * b', new_string: 'return a / b' }, ctx)
		expect(r2.isError).toBeFalsy()
		expect(readFileSync(join(dir, 'c.js'), 'utf8')).toContain('return a / b\r\n')
	})

	it('MultiEdit: CRLF preserved through the atomic batch too', async () => {
		writeFileSync(join(dir, 'd.js'), FILE.replace(/\n/g, '\r\n'))
		const r = await MultiEditTool.call(
			{ file_path: 'd.js', edits: [{ old_string: 'return b', new_string: 'return b + 1' }] },
			ctx,
		)
		expect(r.isError).toBeFalsy()
		expect(readFileSync(join(dir, 'd.js'), 'utf8')).toContain('\treturn b + 1\r\n')
	})

	it('cleanup', () => rmSync(dir, { recursive: true, force: true }))
})
