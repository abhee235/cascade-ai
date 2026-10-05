// ADR-056 rung 3 — the deterministic plan stage. planner-1 measured that a 36B model reads the advisory
// nudge and overrules it; the builder product therefore ORCHESTRATES planning (a pipeline stage the model
// never votes on). These tests pin the trigger conditions and that the planner session really is the
// persona: its own system prompt, its declared tools and NOTHING else, PLAN.md landing on disk.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSession, loadAgentDefs, type CompletionRequest, type ModelProvider } from '@cascade/core'
import { createPlannerSession, ensurePlanPersisted, needsPlanStage, planQualityIssues, planReviseNudge, planSalvageNudge } from '../src/planStage'
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

describe('planQualityIssues — the pinned contract must be usable (35B forensics, 2026-08-11)', () => {
	// Measured: a 35B planner produced a 4,797-char plan with NO Design section that specified
	// "emoji-only product images". PLAN.md is pinned every turn, so all three defects poison every
	// build turn that follows — and the pin truncates at 2,500 chars, so its tail never even arrived.
	const good = `# Shop — Plan\n\n## Goal\nA storefront.\n\n## Views\n- catalog — MediaCard grid\n\n## Design\ncategory: commerce; preset: premium; catalog: NavBar+MediaCard grid; imagery: <Photo web> per item\n\n## Data model\nProduct { id: string }\n`

	it('accepts a terse plan that has a Design section and names real imagery', () => {
		expect(planQualityIssues(good)).toEqual([])
	})

	it('flags a plan longer than the pin cap, naming the invisible tail', () => {
		const issues = planQualityIssues(good + 'x'.repeat(3_000))
		expect(issues.some((i) => i.includes('INVISIBLE'))).toBe(true)
	})

	it('flags a missing Design section', () => {
		expect(planQualityIssues(good.replace('## Design', '## Notes')).some((i) => i.includes('Design'))).toBe(true)
	})

	it('flags emoji planned as imagery — the failure a missing Design section produces', () => {
		expect(planQualityIssues(good.replace('<Photo web> per item', 'emoji per product')).some((i) => i.includes('EMOJI'))).toBe(true)
		expect(planQualityIssues(good + '\n- 🛍️ 🛒 ✅ product art\n').some((i) => i.includes('EMOJI'))).toBe(true)
	})

	it('does not flag a plan that BANS emoji — the planner echoing the rule (ADR-086 P0: 3 of 7 revise rounds)', () => {
		const withImagery = (s: string) => good.replace('<Photo web> per item', s)
		const emojiIssue = (s: string) => planQualityIssues(withImagery(s)).some((i) => i.includes('EMOJI'))
		// Measured phrasings from the Luna plans and the planners' own checklists:
		expect(emojiIssue('one real photo per item (ImageSearch); never emoji or placeholder imagery')).toBe(false)
		expect(emojiIssue('real photos or drawn illustration, NEVER emoji.')).toBe(false)
		expect(emojiIssue('<Photo web> per item (no emoji)')).toBe(false)
		expect(emojiIssue('<Photo web> per item — avoid emojis')).toBe(false)
		// A ban written AFTER the word, or with "zero" (review, 2026-10-04):
		expect(emojiIssue('<Photo web> per item (emoji-free)')).toBe(false)
		expect(emojiIssue('<Photo web> per item. Emoji: none')).toBe(false)
		expect(emojiIssue('<Photo web> per item, zero emoji')).toBe(false)
		expect(emojiIssue('<Photo web> per item; emojis are banned')).toBe(false)
		// …while a planned emoji still is one, even next to a ban on something else:
		expect(emojiIssue('emoji-only product images')).toBe(true)
		expect(emojiIssue('never stock photos; an emoji per category card')).toBe(true)
		expect(emojiIssue('no photos: emojis for each product')).toBe(true)
	})

	it('accepts the BOLD-label section form the planner template actually uses (no false positive)', () => {
		// planner.md writes `**Design:** …`, not `## Design`. A heading-only check would have flagged the
		// measured 35B plan — which was correct — and burned a revise round on it.
		const bold = ['# Shop — Plan', '**Goal:** storefront.', '**Design:** `category: commerce`; `preset: premium`; catalog: MediaCard grid; imagery: `<Photo web>` per item'].join('\n')
		expect(planQualityIssues(bold)).toEqual([])
	})

	it('flags photoFor() planned for a GRID, but not for a single hero', () => {
		// Measured (35B, builder-shop): the plan chose `photoFor()` per product for a six-item catalog —
		// the pack holds ~2 photos per category, so every card repeats. photoFor for ONE hero is correct.
		const grid = ['# P', '**Design:** category: commerce; imagery: `photoFor()` per product, fallback ArtImage'].join('\n')
		expect(planQualityIssues(grid).some((i) => i.includes('GRID'))).toBe(true)
		const hero = ['# P', '**Design:** category: landing; imagery: hero via `photoFor()`, cards via `<Photo web>`'].join('\n')
		expect(planQualityIssues(hero)).toEqual([])
	})

	it('requires the category: routing token, and accepts every mounted category', () => {
		// PLAN.md is re-read every builder turn, so `category:` re-states which skill to load on EVERY turn
		// — durable in a way a turn-one inference from the brief is not (compaction eats that).
		const withCat = (c: string) => ['# P', `**Design:** category: ${c}; preset: premium; imagery: \`<Photo web>\` per item`].join('\n')
		for (const c of ['commerce', 'dashboard', 'landing', 'app-shell', 'social', 'game', 'none']) {
			expect(planQualityIssues(withCat(c)), `${c} should be accepted`).toEqual([])
		}
		const missing = ['# P', '**Design:** preset: premium; imagery: `<Photo web>` per item'].join('\n')
		expect(planQualityIssues(missing).some((i) => i.includes('category:'))).toBe(true)
		// A category we do not mount a skill for is not a routing target — treat it as missing.
		expect(planQualityIssues(withCat('fintech')).some((i) => i.includes('category:'))).toBe(true)
	})

	it('rejects `category: none` when the plan itself reads like a category', () => {
		// Measured (qwen36-agentic-iq4, builder-landing, 2026-08-11): the planner declared `category: none`
		// for a SaaS MARKETING LANDING PAGE, then happened to self-correct on a second write. `none` is the
		// escape hatch from deciding, and it silently skips the whole routing rung.
		const asLanding = ['# Ferrite', '**Design:** category: none; preset: aurora-glass; home: NavBar + Hero + PricingTable + Testimonial + FAQ; imagery: `<Photo web>`'].join('\n')
		const flagged = planQualityIssues(asLanding)
		expect(flagged.some((i) => i.includes('landing'))).toBe(true)

		// …but `none` STAYS legitimate for an app no category fits — a todo list is not a landing page.
		const todo = ['# Todo', '**Design:** category: none; preset: minimal-mono; one list view; imagery: `<ArtImage>` for the empty state'].join('\n')
		expect(planQualityIssues(todo)).toEqual([])

		// ONE stray signal must not contradict a correct `none` — two independent ones are required.
		const oneSignal = ['# Notes', '**Design:** category: none; preset: editorial; a FAQ section at the bottom; imagery: `<ArtImage>`'].join('\n')
		expect(planQualityIssues(oneSignal)).toEqual([])
	})

	it('planReviseNudge names every issue and points at the design skill', () => {
		const nudge = planReviseNudge(['it is too long', 'it has no Design section'])
		expect(nudge).toContain('it is too long')
		expect(nudge).toContain('Skill {name: "design"}')
	})
})

// ADR-086: a blank project's plan has no presets or blocks to name — its Design section IS the theme.
describe('planQualityIssues — the blank start', () => {
	const plan = (design: string) => `# Shop — Plan\n**Goal** — sell beans\n**Views** — catalog\n**Design** — ${design}\n**Stack** — Vite + React\n**Out of scope** — auth\n`

	it('accepts a direction with a palette in hex and both faces — no preset required', () => {
		expect(planQualityIssues(plan('category: commerce; palette: bg #faf7f2, cta #9a3f1e; type: Fraunces / Inter; density: standard'), 'none')).toEqual([])
	})

	it('sends back a mood board: no hex palette, no faces', () => {
		const issues = planQualityIssues(plan('category: commerce; mood: warm, crafted; layout: a grid'), 'none')
		expect(issues).toHaveLength(1)
		expect(issues[0]).toMatch(/no a palette with hex values and no the two faces/)
	})

	it('reads a `## Design` section through its sub-headings and colour lines (review, 2026-10-04)', () => {
		// The old cut stopped at `### Palette` and at a line starting `#FAF7F2`, so a complete plan drew a revise round.
		const md = '# Shop — Plan\n## Goal\nsell beans\n## Design\ncategory: commerce\n### Palette\n#FAF7F2 background, #9A3F1E cta\n### Type\nFraunces display, Inter body\n## Views\ncatalog, cart\n'
		expect(planQualityIssues(md, 'none')).toEqual([])
		// …and it still ENDS at the next same-level heading: a palette that only appears under Views does not count.
		const elsewhere = '# Shop — Plan\n## Design\ncategory: commerce\nmood: warm\n## Views\ncatalog in #FAF7F2, type: Inter\n'
		expect(planQualityIssues(elsewhere, 'none')[0]).toMatch(/no a palette with hex values and no the two faces/)
	})

	it('asks a blank plan with no Design section for a direction, not a preset', () => {
		const [issue] = planQualityIssues('# Shop — Plan\n**Goal** — sell beans\n**Category** — category: commerce\n', 'none')
		expect(issue).toMatch(/palette \(each role with a hex value\)/)
		expect(issue).not.toMatch(/src\/themes/)
	})

	it('does not apply the React-only photo rule, and points the revise nudge at the direction method', () => {
		expect(planQualityIssues(plan('category: commerce; palette: #fff #000; type: Inter / Inter; imagery: photoFor per product in the grid'), 'none')).toEqual([])
		expect(planReviseNudge(['x'], 'none')).toMatch(/how the design direction is written/)
		expect(planReviseNudge(['x'])).toMatch(/presets, the blocks/)
	})
})
