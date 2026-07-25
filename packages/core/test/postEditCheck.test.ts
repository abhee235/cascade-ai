// ADR-059 — post-edit diagnostics: the harness type-checks after a mutating turn and PUSHES the errors
// (the in-IDE pattern: pushed, never pulled). Measured motivation: the Lsp tool's diagnostics op was
// called ZERO times in 90+ Simmer turns while two multi-turn error hunts were pure type errors.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentLoop } from '../src/agent/agentLoop'
import { editedTsFiles, postEditDiagnostics } from '../src/agent/postEditCheck'
import type { ContentBlock, Message } from '../src/protocol'
import type { ToolUse } from '../src/tools/runTool'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'

const ok = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })
const err = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'denied', isError: true })
const write = (id: string, path: string): ToolUse => ({ id, name: 'Write', input: { file_path: path, content: 'x' } })

const TSC_OUT = [
	'> tsc -b --noEmit',
	'src/lib/data.ts(32,3): error TS2741: Property \'favorite\' is missing in type A.',
	'src/lib/data.ts(45,3): error TS2741: Property \'favorite\' is missing in type B.',
	'src/other.ts(3,1): error TS2304: Cannot find name \'zzz\'.',
	'src/lib/data.ts(58,3): error TS2741: Property \'favorite\' is missing in type C.',
	'src/lib/data.ts(70,3): error TS2741: Property \'favorite\' is missing in type D.',
	'src/lib/data.ts(81,3): error TS2741: Property \'favorite\' is missing in type E.',
].join('\n')

describe('editedTsFiles', () => {
	it('keeps successful TS/JS mutations only, deduped', () => {
		const uses = [
			write('1', 'src/a.ts'),
			write('2', 'src/a.ts'), // duplicate
			write('3', 'src/b.css'), // not a TS file
			write('4', 'src/c.tsx'),
			{ id: '5', name: 'Read', input: { file_path: 'src/d.ts' } }, // not mutating
			write('6', 'src/e.ts'), // failed
		]
		expect(editedTsFiles(uses, [ok('1'), ok('2'), ok('3'), ok('4'), ok('5'), err('6')])).toEqual(['src/a.ts', 'src/c.tsx'])
	})
})

describe('postEditDiagnostics — sandbox tsc routing', () => {
	it('parses tsc output, shows edited-file errors FIRST, caps at 5 with a remainder count', async () => {
		const note = await postEditDiagnostics(['src/lib/data.ts'], {
			cwd: '.',
			sandbox: { exec: async () => ({ output: TSC_OUT }) },
		})
		expect(note?.text).toContain('6 error(s)')
		expect(note?.text).toContain("Property 'favorite' is missing")
		// the non-edited-file error is ordered last and falls past the cap of 5
		expect(note?.text).not.toContain('Cannot find name')
		expect(note?.text).toContain('(+ 1 more)')
		expect(note?.text).toContain('Fix ALL the listed errors')
	})

	it('a clean check injects NOTHING', async () => {
		const note = await postEditDiagnostics(['src/a.ts'], { cwd: '.', sandbox: { exec: async () => ({ output: 'no output, exit 0' }) } })
		expect(note).toBeUndefined()
	})

	it('tsc missing = deps never installed → the npm-install DIRECTIVE (the 80-turn blind run)', async () => {
		// Measured: `npx tsc` fetched the fake tsc package and the whole session compiled nothing. The check
		// uses node_modules/.bin/tsc, and `not found` IS the signal — say "npm install", never stay silent.
		const note = await postEditDiagnostics(['src/a.ts'], { cwd: '.', sandbox: { exec: async () => ({ output: 'sh: node_modules/.bin/tsc: not found' }) } })
		expect(note?.missingDeps).toBe(true)
		expect(note?.text).toContain('npm install')
	})

	it('the check command never uses bare npx (the fake-tsc trap)', async () => {
		let cmd = ''
		await postEditDiagnostics(['src/a.ts'], {
			cwd: '.',
			sandbox: {
				exec: async (c: string) => {
					cmd = c
					return { output: '' }
				},
			},
		})
		expect(cmd).toContain('node_modules/.bin/tsc')
		expect(cmd).not.toMatch(/\bnpx tsc/)
	})

	it('a sandbox failure never throws', async () => {
		const note = await postEditDiagnostics(['src/a.ts'], {
			cwd: '.',
			sandbox: {
				exec: async () => {
					throw new Error('container gone')
				},
			},
		})
		expect(note).toBeUndefined()
	})
})

// ADR-075 — THE eval for this fix. The build that motivated it churned types blind: the sandbox container had
// vanished (Docker/WSL restart on sleep), `docker exec` returned "No such container", the check parsed ZERO
// diagnostics and reported a FALSE clean, so real type errors were never pushed and the model guessed forever.
// This proves a dead container now falls through to the in-process LanguageService and pushes the REAL error.
describe('postEditDiagnostics — dead-container fallback to the in-process LanguageService (ADR-075)', () => {
	const withProject = async (fn: (cwd: string) => Promise<void>) => {
		const cwd = mkdtempSync(join(tmpdir(), 'posteditfallback-'))
		mkdirSync(join(cwd, 'src'))
		writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }))
		writeFileSync(join(cwd, 'src/data.ts'), 'export const n: number = "not a number"\n') // TS2322: string not assignable to number
		try {
			await fn(cwd)
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	}

	it('a DEAD container ("No such container") pushes the REAL type error instead of a false clean', async () => {
		await withProject(async (cwd) => {
			const deadContainer = { exec: async () => ({ output: 'Error response from daemon: No such container: fd15c3b0b53f [exit 1]', exitCode: 1 }) }
			const note = await postEditDiagnostics(['src/data.ts'], { cwd, sandbox: deadContainer })
			expect(note).toBeDefined() // NOT the old false-clean
			expect(note?.text).toMatch(/TS2322|not assignable|number/i) // the actual diagnostic reached the model
		})
	})

	it('a daemon-down error also falls back (not just a missing container)', async () => {
		await withProject(async (cwd) => {
			const daemonDown = { exec: async () => ({ output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', exitCode: 1 }) }
			const note = await postEditDiagnostics(['src/data.ts'], { cwd, sandbox: daemonDown })
			expect(note?.text).toMatch(/TS2322|not assignable|number/i)
		})
	})

	it('a WORKING sandbox is still trusted (fallback does not hijack a real clean tsc run)', async () => {
		await withProject(async (cwd) => {
			// real tsc output, clean → must stay clean, NOT fall through to the LanguageService (which WOULD flag the seeded error)
			const liveClean = { exec: async () => ({ output: '', exitCode: 0 }) }
			const note = await postEditDiagnostics(['src/data.ts'], { cwd, sandbox: liveClean })
			expect(note).toBeUndefined()
		})
	})
})

describe('post-edit diagnostics — through the real loop', () => {
	it('after a successful Write, the next request carries the pushed type errors', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'posteditcheck-'))
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'src/data.ts', content: 'export const x = 1' }), done('tool_use')],
			[textDelta('fixing now'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build it' }]
		const sandbox = { root: join(cwd, 'unused'), exec: async () => ({ output: TSC_OUT, exitCode: 0 }) }
		for await (const _ of runAgentLoop(messages, {
			provider,
			model: 'fake',
			cwd,
			signal: new AbortController().signal,
			sandbox: sandbox as never, // structural: only .root (path aliasing) and .exec (the check) are used here
			verifyGate: false,
		})) {
			/* drain */
		}
		const next = JSON.stringify(provider.calls[1]!.messages)
		expect(next).toContain('TypeScript check after your edit(s)')
		expect(next).toContain("Property 'favorite' is missing")
		rmSync(cwd, { recursive: true, force: true })
	})

	it('the missing-deps directive fires ONCE per submit, not on every write while npm runs', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'posteditdeps-'))
		const provider = createFakeProvider([
			[toolUse('w1', 'Write', { file_path: 'src/a.ts', content: 'x' }), done('tool_use')],
			[toolUse('w2', 'Write', { file_path: 'src/b.ts', content: 'y' }), done('tool_use')],
			[textDelta('installing'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'build it' }]
		const sandbox = { root: join(cwd, 'unused'), exec: async () => ({ output: 'sh: node_modules/.bin/tsc: not found' }) }
		for await (const _ of runAgentLoop(messages, { provider, model: 'fake', cwd, signal: new AbortController().signal, sandbox: sandbox as never, verifyGate: false })) {
			/* drain */
		}
		expect(JSON.stringify(messages).split('NO node_modules yet').length - 1).toBe(1)
		rmSync(cwd, { recursive: true, force: true })
	})
})
