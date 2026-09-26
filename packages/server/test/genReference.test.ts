// The design reference must MATCH the template it documents. Nothing enforced that before, and it
// rotted exactly as you would predict: the Photo block (the default imagery primitive the skill tells
// models to use) was absent from blocks.md for weeks, NavBar advertised a "Glass" variant parsed out of
// a code comment, and button sizes were stale. The generator has a `--check` mode; this is the test that
// actually runs it, so a block/kit edit without a regenerate fails here instead of misleading a model.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')

describe('design reference freshness (scripts/gen/genKitReference.mts --check)', () => {
	it('committed blocks.md + components.md match the template source', () => {
		const res = spawnSync('npx', ['tsx', join('scripts', 'gen', 'genKitReference.mts'), '--check'], {
			cwd: ROOT,
			encoding: 'utf8',
			shell: process.platform === 'win32', // npx is a .cmd shim on Windows
			timeout: 120_000,
		})
		const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
		expect(output, output).toContain('references are fresh')
		expect(res.status).toBe(0)
	})
}, 130_000)
