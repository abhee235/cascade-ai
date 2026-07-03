// ADR-048 — input normalization + directive errors, pinned to the EXACT payloads the 3B sent in the
// prose-fallback-3b eval run (its dominant invalid_args failure mode).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeInvalidInput, normalizeInput, schemaKeys } from '../src/tools/inputNormalizer'
import { executeTool } from '../src/tools/runTool'
import { createRegistry } from '../src/tools/toolRegistry'

const readSchema = z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() })
const globSchema = z.object({ pattern: z.string(), path: z.string().optional() })
const editSchema = z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() })

describe('normalizeInput — the observed 3B payloads', () => {
	it('Read {path} → {file_path}  (the dominant mode: 15× in one task)', () => {
		expect(normalizeInput({ path: 'src/report.js' }, readSchema)).toEqual({ file_path: 'src/report.js' })
	})

	it('Read {glob} → {file_path}  (observed: fix-format-duration)', () => {
		expect(normalizeInput({ glob: 'format.js' }, readSchema)).toEqual({ file_path: 'format.js' })
	})

	it('Edit {content, path} → file_path mapped, content left for the validator to flag', () => {
		const out = normalizeInput({ content: 'x', path: 'src/format.js' }, editSchema)
		expect(out).toEqual({ content: 'x', file_path: 'src/format.js' }) // still missing old/new_string → validator reports it
	})

	it('CONSERVATIVE: Glob {path} is a legit schema key — never repurposed into pattern', () => {
		expect(normalizeInput({ path: 'src/commands/remove.js' }, globSchema)).toBeNull()
	})

	it('CONSERVATIVE: never overwrites a canonical key the model already sent', () => {
		expect(normalizeInput({ file_path: 'a.ts', path: 'b.ts' }, readSchema)).toBeNull()
	})

	it('case-variant keys fold onto the canonical spelling', () => {
		expect(normalizeInput({ File_Path: 'a.ts' }, readSchema)).toEqual({ file_path: 'a.ts' })
	})

	it('schemaKeys reaches through .refine() wrappers', () => {
		const wrapped = z.object({ questions: z.array(z.object({ q: z.string() })) }).refine(() => true)
		expect(schemaKeys(wrapped)).toEqual(['questions'])
	})
})

describe('describeInvalidInput — directive, not a Zod dump', () => {
	it('names the missing key, the expected keys, and what was sent', () => {
		const parsed = readSchema.safeParse({ path: 'x' })
		const msg = describeInvalidInput('Read', { path: 'x' }, readSchema, !parsed.success ? parsed.error.message : '')
		expect(msg).toContain('file_path (expected string)')
		expect(msg).toContain('Expected keys: file_path, offset, limit')
		expect(msg).toContain('You sent: path')
		expect(msg).toContain('call Read again')
		expect(msg.length).toBeLessThan(300) // compact — a 3B must be able to act on it
	})
})

describe('end-to-end through the REAL executeTool + registry', () => {
	it('Read {path} now succeeds via normalization', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'norm-'))
		writeFileSync(join(dir, 'hello.txt'), 'hello normalizer')
		const registry = createRegistry()
		const res = await executeTool(
			{ id: 't1', name: 'Read', input: { path: join(dir, 'hello.txt') } }, // wrong key, as the 3B sends it
			{ cwd: dir, abortSignal: new AbortController().signal, registry },
		)
		expect(res.type === 'tool_result' && res.isError).toBeFalsy()
		expect(res.type === 'tool_result' && res.content).toContain('hello normalizer')
	})
})
