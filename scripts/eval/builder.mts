// scripts/eval/builder.mts — Tier-3: the BUILDER bench (PLAN-eval). Measures the product loop the other
// tiers can't see: prompt → edit a real Vite+React scaffold → the app still BUILDS and carries the
// requested UI. This is the loop Cascade sells; a false_done here ("done!" but a white screen) is invisible
// to Tier-1/2.
//
//   npx tsx scripts/eval/builder.mts --verify                    # invariant: seed fails, solution passes
//   npx tsx scripts/eval/builder.mts --model <m> [--scenarios a,b] [--label L]
//
// Mechanics: working copy = pristine template (packages/server/templates/react) + a JUNCTION to the shared
// node_modules (eval/external/builder-template — install once; scenarios stay offline+fast). Check = the
// scenario's check.mjs run in the working copy (vite build exit 0 + built-bundle assertions — behavioural).
// Slower + heavier than Tier-1 by nature: this is a nightly-class suite, not a per-save one.

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, type ModelProvider } from '@cascade/core'

const { values: args } = parseArgs({
	options: {
		model: { type: 'string' },
		label: { type: 'string' },
		scenarios: { type: 'string' },
		verify: { type: 'boolean', default: false },
		provider: { type: 'string', default: 'ollama' },
		'base-url': { type: 'string' },
		temperature: { type: 'string', default: '0' },
	},
})

const ROOT = join(import.meta.dirname, '..', '..')
const SCENARIOS_DIR = join(ROOT, 'eval', 'builder')
const TEMPLATE = join(ROOT, 'packages', 'server', 'templates', 'react')
const SHARED_DEPS = join(ROOT, 'eval', 'external', 'builder-template', 'node_modules')

if (!existsSync(SHARED_DEPS)) {
	console.error(`shared builder deps missing — run once:\n  cp -r ${TEMPLATE} eval/external/builder-template && cd eval/external/builder-template && npm install`)
	process.exit(2)
}

interface Scenario {
	id: string
	template: string
	prompt: string
	budgets: { maxTurns: number; timeoutMs: number }
}

const allIds = readdirSync(SCENARIOS_DIR).filter((d) => existsSync(join(SCENARIOS_DIR, d, 'scenario.json')))
const wanted = args.scenarios ? args.scenarios.split(',').map((s) => s.trim()) : allIds

/** Working copy: pristine template files + junction to the shared node_modules (fast, offline, disposable). */
function makeWorkdir(id: string): string {
	const work = mkdtempSync(join(tmpdir(), `cascade-builder-${id}-`))
	cpSync(TEMPLATE, work, { recursive: true })
	symlinkSync(SHARED_DEPS, join(work, 'node_modules'), 'junction')
	return work
}

function runCheck(id: string, work: string): { ok: boolean; output: string } {
	const res = spawnSync(process.execPath, [join(SCENARIOS_DIR, id, 'check.mjs')], { cwd: work, encoding: 'utf8', timeout: 180_000 })
	return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function cleanup(work: string): void {
	try {
		rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
	} catch (e) {
		console.warn(`(cleanup left ${work}: ${e instanceof Error ? e.message.split('\n')[0] : e})`)
	}
}

// ── --verify: the fixture invariant (seed must FAIL, solution must PASS) ────────────────────────────────
if (args.verify) {
	let bad = 0
	for (const id of wanted) {
		const seedWork = makeWorkdir(id)
		const seed = runCheck(id, seedWork)
		cleanup(seedWork)
		const solWork = makeWorkdir(id)
		cpSync(join(SCENARIOS_DIR, id, 'solution'), solWork, { recursive: true })
		const sol = runCheck(id, solWork)
		cleanup(solWork)
		const ok = !seed.ok && sol.ok
		if (!ok) {
			bad++
			console.error(`--- ${id}: ${seed.ok ? 'seed unexpectedly PASSED' : 'solution FAILED'} ---\n${(seed.ok ? seed.output : sol.output).slice(-1200)}`)
		}
		console.log(`${id}: seed-fails ${!seed.ok ? '✅' : '❌'} · solution-passes ${sol.ok ? '✅' : '❌'}`)
	}
	console.log(bad === 0 ? `All ${wanted.length} scenarios sound.` : `${bad}/${wanted.length} VIOLATE the invariant.`)
	process.exit(bad === 0 ? 0 : 1)
}

// ── run mode ─────────────────────────────────────────────────────────────────────────────────────────────
if (!args.model) {
	console.error('usage: builder.mts --verify | builder.mts --model <m> [--scenarios a,b] [--label L]')
	process.exit(2)
}
const label = args.label ?? `builder-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`
const runDir = join(ROOT, 'eval', 'runs', label)
mkdirSync(join(runDir, 'traces'), { recursive: true })

function withTemperature(p: ModelProvider, temperature: number): ModelProvider {
	return {
		id: p.id,
		complete: (req, sig) => p.complete({ ...req, temperature }, sig),
		stream: (req, sig) => p.stream({ ...req, temperature }, sig),
		...(p.embed ? { embed: p.embed.bind(p) } : {}),
		...(p.detectModelLimits ? { detectModelLimits: p.detectModelLimits.bind(p) } : {}),
	}
}

writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ label, model: args.model, tier: 'builder', scenarios: wanted, startedAt: new Date().toISOString() }, null, '\t'))
console.log(`builder bench "${label}" — model=${args.model} scenarios=${wanted.length}\n`)

for (const id of wanted) {
	const scenario: Scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, id, 'scenario.json'), 'utf8'))
	const work = makeWorkdir(id)
	const tracePath = join(runDir, 'traces', `${id}.jsonl`)
	process.stdout.write(`▶ ${id} `)

	const provider = withTemperature(createProvider({ provider: args.provider!, model: args.model!, baseUrl: args['base-url'] }), Number(args.temperature))
	const session = createSession({
		cwd: work,
		provider,
		model: args.model!,
		mode: 'bypass',
		tracer: new JsonlTracer(tracePath),
		autoMemory: false,
		maxTurns: scenario.budgets.maxTurns,
	})
	const t0 = Date.now()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		session.abort()
	}, scenario.budgets.timeoutMs)
	try {
		for await (const ev of session.submit(scenario.prompt)) {
			if (ev.type === 'toolStart') process.stdout.write('.')
			else if (ev.type === 'question') session.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
			else if (ev.type === 'permission') session.respondPermission(ev.id, 'allow')
		}
	} catch {
		/* abort may throw; the row records timedOut */
	} finally {
		clearTimeout(timer)
		await session.dispose().catch(() => {})
	}
	const wallMs = Date.now() - t0
	const check = runCheck(id, work)
	cleanup(work)

	const row = { ts: new Date().toISOString(), label, model: args.model, scenario: id, solved: check.ok, timedOut, wallMs, traceFile: `${id}.jsonl` }
	appendFileSync(join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`)
	console.log(` ${check.ok ? '✅' : timedOut ? '⏱ timeout' : '❌'}  ${Math.round(wallMs / 1000)}s${check.ok ? '' : `\n   ${check.output.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`}`)
}
console.log(`\nresults → ${runDir}`)
