// ADR-056 rung 3 — the deterministic plan stage. planner-1 measured that a 36B model reads the advisory
// nudge and overrules it; the builder product therefore ORCHESTRATES planning (a pipeline stage the model
// never votes on). These tests pin the trigger conditions and that the planner session really is the
// persona: its own system prompt, its declared tools and NOTHING else, PLAN.md landing on disk.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSession, loadAgentDefs, type CompletionRequest, type ModelProvider } from '@cascade/core'
import { createPlannerSession, ensurePlanPersisted, needsPlanStage, planSalvageNudge } from '../src/planStage'
import { agentDirsFor, ProjectManager } from '../src/projectManager'

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const AGENTS = mkdtempSync(join(tmpdir(), 'planstage-agents-'))
writeFileSync(
	join(AGENTS, 'planner.md'),
	`---\nname: planner\ndescription: Plans first.\ntools: Read, Glob, Grep, Skill, AskUserQuestion, Write(PLAN.md)\nmaxTurns: 10\nskills: architecture\nproactive: true\n---\nYou are the PLANNER. Write PLAN.md.`,
)
const PASSIVE = mkdtempSync(join(tmpdir(), 'planstage-passive-'))
writeFileSync(join(PASSIVE, 'planner.md'), `---\nname: planner\ndescription: Plans on request.\n---\nPlan when asked.`)
const SKILLS = mkdtempSync(join(tmpdir(), 'planstage-skills-'))
mkdirSync(join(SKILLS, 'architecture'))
writeFileSync(join(SKILLS, 'architecture', 'SKILL.md'), `---\nname: architecture\ndescription: How to structure the app. Load when structuring an app.\n---\nSPLIT INTO SMALL COMPONENTS.`)

/** Minimal scripted provider (house style of projectManager.test.ts) that also records every request —
 *  the advertised tool list is the assertion surface for the session-level allowlist. */
function scriptedProvider(script: 'writes-plan' | 'silent') {
	const requests: CompletionRequest[] = []
	let call = 0
	const provider: ModelProvider = {
		id: 'fake',
		async complete() {
			return { text: '' }
		},
		async *stream(req) {
			requests.push(req)
			call++
			if (script === 'writes-plan' && call === 1) {
				yield { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'PLAN.md', content: '# Plan\n- Goal: test' } } as const
				yield { type: 'done', stopReason: 'tool_use' } as const
				return
			}
			yield { type: 'text_delta', text: 'Plan summary.' } as const
			yield { type: 'done', stopReason: 'end_turn' } as const
		},
	}
	return { provider, requests }
}

// ── needsPlanStage: the trigger conditions ───────────────────────────────────────────────────────────
describe('needsPlanStage', () => {
	it('fires on fresh conversation + no PLAN.md + proactive planner', () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-'))
		expect(needsPlanStage(dir, 0, [AGENTS])?.name).toBe('planner')
	})

	it('skipped when PLAN.md already exists (new chat on a planned project builds immediately)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-'))
		writeFileSync(join(dir, 'PLAN.md'), '# plan')
		expect(needsPlanStage(dir, 0, [AGENTS])).toBeUndefined()
	})

	it('skipped mid-conversation (plan deletion later is the core nudge’s job, not a surprise re-stage)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-'))
		expect(needsPlanStage(dir, 3, [AGENTS])).toBeUndefined()
	})

	it('skipped for a passive planner and when no planner is mounted (frontmatter is the opt-in)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-'))
		expect(needsPlanStage(dir, 0, [PASSIVE])).toBeUndefined()
		expect(needsPlanStage(dir, 0, [mkdtempSync(join(tmpdir(), 'planstage-empty-'))])).toBeUndefined()
	})

	it('user shadowing planner.md WITHOUT proactive silences the stage (later dir wins)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-'))
		expect(needsPlanStage(dir, 0, [AGENTS, PASSIVE])).toBeUndefined()
	})
})

// ── createPlannerSession: the persona is real ────────────────────────────────────────────────────────
describe('createPlannerSession', () => {
	const def = loadAgentDefs([AGENTS])[0]!

	it('runs the def as a top-level session: its prompt, its tools ONLY, PLAN.md on disk', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'planstage-run-'))
		const { provider, requests } = scriptedProvider('writes-plan')
		const session = createPlannerSession(def, { dir, provider, model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('Build a shop')) {
			/* drain */
		}
		await session.dispose()

		expect(existsSync(join(dir, 'PLAN.md'))).toBe(true)
		expect(readFileSync(join(dir, 'PLAN.md'), 'utf8')).toContain('# Plan')
		const advertised = requests[0]!.tools?.map((t) => t.name) ?? []
		// The def's allowlist and NOTHING else: a planner must not shell out, delegate, or edit app code.
		expect(advertised).toEqual(expect.arrayContaining(['Read', 'Write', 'Skill', 'AskUserQuestion']))
		expect(advertised).not.toContain('Bash')
		expect(advertised).not.toContain('Subagent')
		expect(advertised).not.toContain('Edit')
		// Persona + preloaded skill body are IN the system prompt (agentChildInstructions).
		expect(requests[0]!.system).toContain('You are the PLANNER')
		expect(requests[0]!.system).toContain('SPLIT INTO SMALL COMPONENTS')
	})
})

// ── ensurePlanPersisted: the suspenders (planner-6 measured the non-deterministic write) ────────────────
describe('ensurePlanPersisted', () => {
	const def = loadAgentDefs([AGENTS])[0]!
	function spokenPlanProvider(text: string): ModelProvider {
		return {
			id: 'fake',
			async complete() {
				return { text: '' }
			},
			async *stream() {
				yield { type: 'text_delta', text } as const
				yield { type: 'done', stopReason: 'end_turn' } as const
			},
		}
	}

	it('keeps a PLAN.md the planner actually wrote (does not clobber it)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'persist-'))
		const session = createPlannerSession(def, { dir, provider: scriptedProvider('writes-plan').provider, model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('Build a shop')) {
			/* drain — the planner Writes PLAN.md */
		}
		const wrote = readFileSync(join(dir, 'PLAN.md'), 'utf8')
		expect(ensurePlanPersisted(dir, session)).toBe(true)
		expect(readFileSync(join(dir, 'PLAN.md'), 'utf8')).toBe(wrote) // untouched
		await session.dispose()
	})

	it('MIN-VIABLE-PLAN: a junk fragment is NOT persisted — no file, the nudge stays armed (iterate-7)', async () => {
		// A degraded stage once produced "Let me first examine the existing project state…" (64 chars) which
		// got persisted — suppressing the plan nudge AND pinning noise. Fragments must leave NO file.
		const dir = mkdtempSync(join(tmpdir(), 'persist-'))
		const session = createPlannerSession(def, { dir, provider: spokenPlanProvider('Let me first examine the existing project state before building.'), model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('Build a shop')) {
			/* drain */
		}
		expect(ensurePlanPersisted(dir, session)).toBe(false)
		expect(existsSync(join(dir, 'PLAN.md'))).toBe(false) // junk is NOT better than nothing
		await session.dispose()
	})

	it('MIN-VIABLE-PLAN: headed but too-short output is also rejected', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'persist-'))
		const session = createPlannerSession(def, { dir, provider: spokenPlanProvider('# Shop — Plan\nTBD'), model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('Build a shop')) {
			/* drain */
		}
		expect(ensurePlanPersisted(dir, session)).toBe(false)
		expect(existsSync(join(dir, 'PLAN.md'))).toBe(false)
		await session.dispose()
	})

	it('falls back to the final message when the planner SPOKE the plan instead of writing it (planner-6)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'persist-'))
		const spoken = "I'm in planner mode so I can't build. Here's the plan:\n\n# Shop — Plan\n## Goal\nA storefront for small-batch goods with catalog, cart and checkout.\n## Views\n- Catalog — grid of products\n- Cart — line items and totals\n## Data model\ninterface Product { id: string; name: string; price: number }\n## Out of scope\nbackend, auth"
		const session = createPlannerSession(def, { dir, provider: spokenPlanProvider(spoken), model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('Build a shop')) {
			/* drain — planner writes NOTHING, just talks */
		}
		expect(existsSync(join(dir, 'PLAN.md'))).toBe(false) // nothing on disk yet
		expect(ensurePlanPersisted(dir, session)).toBe(true)
		const plan = readFileSync(join(dir, 'PLAN.md'), 'utf8')
		expect(plan.startsWith('# Shop — Plan')).toBe(true) // preamble stripped to the first heading
		expect(plan).toContain('- Catalog')
		expect(plan).not.toContain('planner mode') // the "I'm in planner mode" preamble is gone
		await session.dispose()
	})

	it('returns false when the planner produced no text and no file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'persist-'))
		const session = createPlannerSession(def, { dir, provider: spokenPlanProvider('   '), model: 'fake', skillDirs: [SKILLS] })
		for await (const _ of session.submit('x')) {
			/* drain */
		}
		expect(ensurePlanPersisted(dir, session)).toBe(false)
		expect(existsSync(join(dir, 'PLAN.md'))).toBe(false)
		await session.dispose()
	})
})

// ── ProjectManager wiring ────────────────────────────────────────────────────────────────────────────
describe('ProjectManager.planSessionFor', () => {
	function manager() {
		const root = mkdtempSync(join(tmpdir(), 'planstage-pm-'))
		const calls: string[] = []
		const mgr = new ProjectManager({
			root,
			model: 'fake',
			createSessionFor: (dir) => createSession({ cwd: dir, provider: scriptedProvider('silent').provider, model: 'fake' }),
			createPlanSessionFor: (dir, def) => {
				calls.push(def.name)
				return createPlannerSession(def, { dir, provider: scriptedProvider('writes-plan').provider, model: 'fake', skillDirs: [SKILLS] })
			},
		})
		return { mgr, calls }
	}

	it('stage on first submit of a fresh project; none once PLAN.md exists', () => {
		const { mgr, calls } = manager()
		const p = mgr.create('Shop')
		mgr.open(p.id)
		// The REAL server-owned planner.md must be discoverable for the default wiring (proactive: true).
		expect(loadAgentDefs(agentDirsFor('.')).find((d) => d.name === 'planner')?.proactive).toBe(true)

		const stage = mgr.planSessionFor(p.id)
		expect(stage).toBeDefined()
		expect(calls).toEqual(['planner'])
		// Once the plan exists (as it would after the stage ran), the next submit goes straight to building.
		const dir = [...new Set([mgr.dirOf(p.id)!])][0]!
		writeFileSync(join(dir, 'PLAN.md'), '# plan')
		expect(mgr.planSessionFor(p.id)).toBeUndefined()
	})

	it('no stage for a project that is not open, and none mid-conversation', async () => {
		const { mgr } = manager()
		const p = mgr.create('Shop')
		expect(mgr.planSessionFor(p.id)).toBeUndefined() // not open()ed yet
		const session = mgr.open(p.id)
		for await (const _ of session.submit('hi')) {
			/* drain — gives the builder session history */
		}
		expect(mgr.planSessionFor(p.id)).toBeUndefined() // fresh no more
	})
})

describe('planSalvageNudge (dokar-9B forensics) — spoken questions are a protocol violation', () => {
	// The measured failure: the planner composed three clarifying questions as PROSE, ended its text
	// "Let me ask these questions:" — and called nothing. The stage fell through with no questions asked
	// and no plan; the builder assumed everything.
	const sessionWith = (text: string) =>
		({ getHistory: () => [{ role: 'user', content: 'build dokar' }, { role: 'assistant', content: [{ type: 'text', text }] }] }) as never

	it('question-shaped final text → the nudge names AskUserQuestion and the plain-TEXT violation', () => {
		const nudge = planSalvageNudge(sessionWith('Before proceeding: 1. Persistence? 2. Auth needed? Let me ask these questions:'))
		expect(nudge).toContain('AskUserQuestion')
		expect(nudge).toContain('plain TEXT')
	})

	it('no questions, just chatter → the nudge demands the plan itself', () => {
		const nudge = planSalvageNudge(sessionWith('I will help you build an advanced to-do list app.'))
		expect(nudge).toContain('Produce the plan NOW')
	})
})
