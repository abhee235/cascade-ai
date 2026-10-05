import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { NoopTracer, type ActivityEvent, type CascadeSession, type ModelProvider } from '@cascade/core'
import { BUILDER_BEHAVIOR, BUILDER_BEHAVIOR_FREE, builderSessionOptions, runBuilderTurn, runPlanStage, type BuilderSessionDeps } from '../src/builderSession'
import { stampStart } from '../src/templates'
import { HostSandbox } from '../src/hostSandbox'
import { resourceDir } from '../src/resources'

// ADR-085 P0 task 1: the product and the bench build the builder session from ONE function. These tests pin
// the product contract and prove the bench can differ only in the fields BenchDifferences names.

const fakeProvider: ModelProvider = {
  id: 'fake',
  async complete() {
    return { text: '' }
  },
  async *stream() {
    yield { type: 'done', stopReason: 'end_turn' }
  },
}

function deps(): BuilderSessionDeps {
  const dir = mkdtempSync(join(tmpdir(), 'cascade-bs-'))
  return {
    dir,
    provider: fakeProvider,
    active: { provider: 'fake', model: 'fake', contextWindow: 65_536 },
    tracer: NoopTracer,
    vision: false,
    sandbox: new HostSandbox(dir),
    extraInstructions: 'AI RULES: use the theme tokens.',
  }
}

const toolNames = (o: ReturnType<typeof builderSessionOptions>) => (o.extraTools ?? []).map((t) => t.name)

describe('builderSessionOptions', () => {
  it('is the product builder contract', () => {
    const d = deps()
    const o = builderSessionOptions(d)
    expect(o.cwd).toBe(d.dir)
    expect(o.frozenPaths).toEqual([]) // ADR-086 P1: the blocks are patterns, the kit is editable
    expect(o.excludeTools).toEqual(['AskUserQuestion', 'Lsp'])
    expect(o.mode).toBe('bypass') // a sandbox is the permission boundary
    expect(o.maxTurns).toBe(500)
    expect(o.autoMemory).toBe(true)
    expect(o.checkCommand).toBe('npm run build')
    expect(o.loadProjectHooks).toBe(false)
    expect(o.maxOutputTokens).toBe('auto')
    expect(o.contextWindow).toBe(65_536)
    expect(o.skillDirs).toEqual([resourceDir('skills', 'builder'), join(d.dir, '.cascade', 'skills')])
    expect(o.agentDirs).toEqual([resourceDir('agents', 'builder'), join(d.dir, '.cascade', 'agents')])
    expect(o.contextFiles).toEqual([join(d.dir, 'PLAN.md')])
    expect(o.extraInstructions?.startsWith(BUILDER_BEHAVIOR)).toBe(true)
    expect(o.extraInstructions).toContain('AI RULES: use the theme tokens.')
    expect(toolNames(o)).toEqual(expect.arrayContaining(['Browser', 'ImageSearch']))
  })

  it('no sandbox → default permission mode and no Browser (nothing to look at)', () => {
    const o = builderSessionOptions({ ...deps(), sandbox: undefined })
    expect(o.mode).toBe('default')
    expect(toolNames(o)).not.toContain('Browser')
  })

  it('the bench differs from the product ONLY in the BenchDifferences fields', () => {
    const d = deps()
    const product = builderSessionOptions(d)
    const bench = builderSessionOptions(d, { autoMemory: false, maxTurns: 60 })
    const norm = (o: typeof product) => ({ ...o, extraTools: toolNames(o) }) // tool instances differ per call
    const a = norm(product) as Record<string, unknown>
    const b = norm(bench) as Record<string, unknown>
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    const differing = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort()
    expect(differing).toEqual(['autoMemory', 'maxTurns'])
  })
})

/** A planner stand-in: each submit() is one round; `onRound` may write PLAN.md like the real planner would. */
function stubPlanner(onRound: (n: number) => void) {
  const prompts: string[] = []
  let disposed = false
  const session = {
    async *submit(text: string) {
      prompts.push(text)
      onRound(prompts.length)
      yield { type: 'text', text: 'working' } as unknown as ActivityEvent
      yield { type: 'turnDone' } as unknown as ActivityEvent
    },
    getHistory: () => [],
    dispose: async () => {
      disposed = true
    },
  } as unknown as CascadeSession
  return { session, prompts, disposed: () => disposed }
}

describe('runPlanStage', () => {
  it('a planner that ends with no plan gets exactly ONE salvage round, then is disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-ps-'))
    const p = stubPlanner(() => {})
    const events: string[] = []
    await runPlanStage(dir, p.session, 'build a shop', { onEvent: (e) => events.push(e.type), aborted: () => false })
    expect(p.prompts).toHaveLength(2)
    expect(p.prompts[0]).toBe('build a shop')
    expect(events).not.toContain('turnDone') // to the user the stage is one turn
    expect(p.disposed()).toBe(true)
  })

  it('a written plan that fails the quality check gets ONE revise round, announced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-ps-'))
    const p = stubPlanner((n) => n === 1 && writeFileSync(join(dir, 'PLAN.md'), '# Plan\n\n- a page\n'))
    const status: string[] = []
    await runPlanStage(dir, p.session, 'build a shop', { onEvent: () => {}, onStatus: (s) => status.push(s), aborted: () => false })
    expect(p.prompts).toHaveLength(2)
    expect(status).toEqual(['Tightening the plan…'])
    expect(p.disposed()).toBe(true)
  })

  it('an aborted stage runs no extra round but still disposes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-ps-'))
    const p = stubPlanner(() => {})
    await runPlanStage(dir, p.session, 'build a shop', { onEvent: () => {}, aborted: () => true })
    expect(p.prompts).toHaveLength(1)
    expect(existsSync(join(dir, 'PLAN.md'))).toBe(false)
    expect(p.disposed()).toBe(true)
  })
})

describe('runBuilderTurn — install-first', () => {
  const stubSession = () => {
    const prompts: string[] = []
    const session = { async *submit(text: string) { prompts.push(text) } } as unknown as CascadeSession
    return { session, prompts }
  }
  const countingRuntime = () => {
    let installs = 0
    return { rt: { hasDependencies: async () => false, installDependencies: async () => (installs++, true) }, installs: () => installs }
  }

  it('skips the install in a blank project with no package.json yet — nothing is declared (review, 2026-10-04)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-rt-'))
    const s = stubSession()
    const r = countingRuntime()
    const status: string[] = []
    await runBuilderTurn(s.session, 'build it', { onEvent: () => {}, onStatus: (m) => status.push(m) }, { runtime: r.rt, dir })
    expect(r.installs()).toBe(0)
    expect(status).not.toContain('Installing dependencies…')
    expect(s.prompts).toEqual(['build it'])
  })

  it('still installs first when package.json declares dependencies that are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-rt-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }))
    const r = countingRuntime()
    await runBuilderTurn(stubSession().session, 'build it', { onEvent: () => {} }, { runtime: r.rt, dir })
    expect(r.installs()).toBe(1)
  })
})

// ADR-086: the blank ("None") start — its own profile, sharing the React profile's rules by reference.
describe('the blank start', () => {
	const blank = () => {
		const d = deps()
		stampStart(d.dir, 'none')
		return d
	}

	it('builds the free profile: nothing frozen, the free role, the free skill/agent layer, no template tools', () => {
		const d = blank()
		const o = builderSessionOptions(d)
		expect(o.frozenPaths).toEqual([])
		expect(o.extraInstructions?.startsWith(BUILDER_BEHAVIOR_FREE)).toBe(true)
		// builder-free SHADOWS the template-bound skills and planner by name; generic ones are inherited.
		expect(o.skillDirs).toEqual([resourceDir('skills', 'builder'), resourceDir('skills', 'builder-free'), join(d.dir, '.cascade', 'skills')])
		expect(o.agentDirs).toEqual([resourceDir('agents', 'builder'), resourceDir('agents', 'builder-free'), join(d.dir, '.cascade', 'agents')])
		expect(toolNames(o)).toEqual(expect.arrayContaining(['Browser', 'ImageSearch']))
		for (const t of ['ApplyPack', 'TemplateAudit', 'Restyle']) expect(toolNames(o)).not.toContain(t)
	})

	it('pins the React prompt, and the blank start shares its rules instead of copying them', () => {
		// The React builder's prompt prefix (KV cache). If you change BUILDER_BEHAVIOR on purpose, update this.
		// Changed on purpose by ADR-086 P1 (was 72683b22d3c85219): the blocks are patterns, not a frozen library;
		// then the brand became the app's name as a wordmark (the user's call: a logo is personal).
		expect(createHash('sha256').update(BUILDER_BEHAVIOR).digest('hex').slice(0, 16)).toBe('ec70a054fa385d7b')
		for (const rule of ['- Never end your turn to ask a question', '- No broad process kills', '- PLAN.md (pinned below) is the contract']) {
			expect(BUILDER_BEHAVIOR_FREE).toContain(BUILDER_BEHAVIOR.split('\n').find((l) => l.startsWith(rule))!)
		}
		expect(BUILDER_BEHAVIOR_FREE).not.toContain('TemplateAudit')
		expect(BUILDER_BEHAVIOR_FREE).toContain('npm run dev -- --host --port')
	})

	it('hands attached images to the planner in its FIRST round only', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cascade-ps-'))
		const seen: { text: string; images?: unknown }[] = []
		const planner = {
			async *submit(text: string, images?: unknown) {
				seen.push({ text, images })
				yield { type: 'turnDone' } as unknown as ActivityEvent
			},
			getHistory: () => [],
			dispose: async () => {},
		} as unknown as CascadeSession
		const refs = ['data:image/png;base64,AAAA']
		await runPlanStage(dir, planner, 'build a shop like this', { onEvent: () => {}, aborted: () => false }, refs as never)
		expect(seen).toHaveLength(2) // no plan written → one salvage round
		expect(seen[0]).toEqual({ text: 'build a shop like this', images: refs })
		expect(seen[1]!.images).toBeUndefined()
	})
})
