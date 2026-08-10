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

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, type CascadeSession, type ModelProvider } from '@cascade/core'
import { BUILDER_BEHAVIOR } from '../../packages/server/src/projectManager'
import { createPlannerSession, ensurePlanPersisted, needsPlanStage, planSalvageNudge } from '../../packages/server/src/planStage'
import { HostSandbox } from '../../packages/server/src/hostSandbox'
import { createPackTool } from '../../packages/server/src/packTool'
import { keepAwake } from './keepAwake.mts'
import { fanout, OtelTracer } from './otelTracer.mts'

const { values: args } = parseArgs({
	options: {
		model: { type: 'string' },
		label: { type: 'string' },
		scenarios: { type: 'string' },
		verify: { type: 'boolean', default: false },
		keep: { type: 'boolean', default: false }, // keep the workdir after the run (replay/inspection)
		provider: { type: 'string', default: 'ollama' },
		'base-url': { type: 'string' },
		temperature: { type: 'string', default: '0' },
		// VRAM headroom knob (iterate-2 forensics: llama-server aborts at ~1.3GB free with all layers
		// offloaded). Offload N layers instead of all → frees VRAM for compute buffers; costs some speed.
		// (iterate-3 measured that cost: CPU-streamed MoE experts ≈ 5 tok/s — usually the WRONG knob.)
		'gpu-layers': { type: 'string' },
		// Arbitrary Ollama-native options as JSON, e.g. '{"num_batch":256}' (shrink compute buffers WITHOUT
		// evicting weights — the right knob when the assert is allocation pressure, not weight residency).
		'ollama-options': { type: 'string' },
		// Ops override of the scenario's pinned window (e.g. 32768 = the PRODUCT config). The 16k pin stays
		// the canonical compaction-torture fixture; consistency questions get measured at the real config.
		'context-window': { type: 'string' },
		// Ops override of the scenario's timeout — a longer leash for a slow-but-honest config (measured:
		// Q4_K_M at the 16k envelope needs ~3h for 6 rounds) without rewriting the fixture.
		'timeout-ms': { type: 'string' },
		// Survive the launching session closing. Measured TWICE: a background run whose owning shell died
		// orphaned mid-flight — the runner wedged writing progress dots to the dead stdout pipe BEFORE the
		// first trace event, while keep-awake held the box up for ~24h. --detach re-spawns the runner as its
		// own detached process with stdout/stderr on a FILE (file writes can't block on a dead reader);
		// progress is then observable via <runDir>/runner.log + traces, completion via results.jsonl.
		detach: { type: 'boolean', default: false },
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
	/** Single-shot prompt (v1 scenarios)… */
	prompt?: string
	/** …or an ITERATIVE session: each prompt is a follow-up on the SAME session (history carries over —
	 *  this is what exercises edits-to-existing-code, the todo list, compaction growth, and the verify
	 *  gate per round; the real product experience is iterative, not one-shot). */
	prompts?: string[]
	budgets: { maxTurns: number; timeoutMs: number }
	/** Pin the window (like Tier-1 fixtures): a scenario can FORCE repeated context fills so compaction is
	 *  exercised many times over a long iterative session (user requirement: 5–6+ fills, every layer seen). */
	session?: { contextWindow?: number; maxOutputTokens?: number }
}

const allIds = readdirSync(SCENARIOS_DIR).filter((d) => existsSync(join(SCENARIOS_DIR, d, 'scenario.json')))
const wanted = args.scenarios ? args.scenarios.split(',').map((s) => s.trim()) : allIds

/** Working copy: pristine template files + junction to the shared node_modules (fast, offline, disposable). */
function makeWorkdir(id: string): string {
	// Repo-local, NOT %TEMP%: Windows Storage Sense swept a live run's template files out from under the
	// session at 96% disk (shop-iterate-1 — package.json/node_modules vanished mid-round; the model rebuilt
	// the scaffold from memory). The OS never cleans repo dirs; eval/.work is gitignored.
	mkdirSync(join(ROOT, 'eval', '.work'), { recursive: true })
	const work = mkdtempSync(join(ROOT, 'eval', '.work', `builder-${id}-`))
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

// ── --detach: re-spawn as an independent process and exit (see the flag comment) ────────────────────────
if (args.detach && !process.env.CASCADE_DETACHED) {
	const logPath = join(runDir, 'runner.log')
	const out = openSync(logPath, 'a')
	// execArgv carries tsx's loader registration (--import/--require) — without it the child is PLAIN node
	// and dies on the first extensionless TS import (measured on the first detached launch).
	const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1).filter((a) => a !== '--detach')], {
		detached: true,
		stdio: ['ignore', out, out],
		cwd: process.cwd(),
		env: { ...process.env, CASCADE_DETACHED: '1' },
		windowsHide: true,
	})
	child.unref()
	console.log(`detached: PID ${child.pid} — progress → ${logPath}, verdict → ${join(runDir, 'results.jsonl')}`)
	process.exit(0)
}

function withTemperature(p: ModelProvider, temperature: number): ModelProvider {
	return {
		id: p.id,
		complete: (req, sig) => p.complete({ ...req, temperature }, sig),
		stream: (req, sig) => p.stream({ ...req, temperature }, sig),
		...(p.embed ? { embed: p.embed.bind(p) } : {}),
		...(p.detectModelLimits ? { detectModelLimits: p.detectModelLimits.bind(p) } : {}),
		...(p.recover ? { recover: p.recover.bind(p) } : {}), // WATCHDOG hook must survive the wrapper
	}
}

writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ label, model: args.model, tier: 'builder', scenarios: wanted, startedAt: new Date().toISOString() }, null, '\t'))
console.log(`builder bench "${label}" — model=${args.model} scenarios=${wanted.length}\n`)
// Builder scenarios (esp. iterate) run far past the 60-min sleep/hibernate threshold — hold the box awake.
// keepAwake self-reaps on process exit; release() is called explicitly after the run loop below.
const awake = keepAwake()

for (const id of wanted) {
	const scenario: Scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, id, 'scenario.json'), 'utf8'))
	const work = makeWorkdir(id)
	const tracePath = join(runDir, 'traces', `${id}.jsonl`)
	process.stdout.write(`▶ ${id} `)

	const nativeOptions = {
		...(args['ollama-options'] ? JSON.parse(args['ollama-options']) : {}),
		...(args['gpu-layers'] ? { num_gpu: Number(args['gpu-layers']) } : {}),
	}
	const provider = withTemperature(
		createProvider({
			provider: args.provider!,
			model: args.model!,
			baseUrl: args['base-url'],
			...(Object.keys(nativeOptions).length ? { options: nativeOptions } : {}),
		}),
		Number(args.temperature),
	)
	// ADR-053: with an OTLP endpoint configured, fan the trace out to the viewer (Phoenix/Langfuse) live.
	const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	const otel = otelEndpoint ? new OtelTracer({ endpoint: otelEndpoint, service: `${label}:${id}`, attributes: { 'cascade.model': args.model! } }) : undefined

	// Same capability dirs for the builder session AND the plan stage (mirrors projectManager's
	// skillDirsFor/agentDirsFor — base server-owned dirs first, project .cascade/ shadows).
	const skillDirs = [join(ROOT, 'packages', 'server', 'skills', 'builder'), join(work, '.cascade', 'skills')]
	const agentDirs = [join(ROOT, 'packages', 'server', 'agents', 'builder'), join(work, '.cascade', 'agents')]
	// FIDELITY: identical to the product's builder session (projectManager.ts) — same behavior instructions,
	// same declared check — so forensics on a bench trace transfer 1:1 to the real product experience.
	const session = createSession({
		cwd: work,
		provider,
		model: args.model!,
		mode: 'bypass',
		// FIDELITY: the product's default runtime is HostSandbox (ADR-081) — on Windows that now means Git
		// Bash when present, cmd fallback otherwise, and the Bash tool advertises whichever it got. Without
		// this the bench ran core's sandbox-less spawn (always cmd on Windows) and measured a shell the
		// product no longer uses.
		sandbox: new HostSandbox(work),
		tracer: otel ? fanout(new JsonlTracer(tracePath), otel) : new JsonlTracer(tracePath),
		autoMemory: false,
		maxTurns: scenario.budgets.maxTurns,
		extraInstructions: BUILDER_BEHAVIOR,
		checkCommand: 'npm run build',
		contextWindow: args['context-window'] ? Number(args['context-window']) : scenario.session?.contextWindow,
		maxOutputTokens: scenario.session?.maxOutputTokens,
		// ADR-055/056 fidelity: same skills + named agents as the product's builder sessions.
		skillDirs,
		agentDirs,
		contextFiles: [join(work, 'PLAN.md')], // ADR-056 rung 5: pin PLAN.md into the builder prompt (fidelity)
		// ADR-066 fidelity: the product injects the ApplyPack tool (projectManager). Without it, a graduation
		// scenario couldn't call it. Self-gates to undefined once applied (createPackTool → filter Boolean).
		// (The Browser tool is product-only — it needs a Docker sandbox the bench doesn't have.)
		extraTools: [createPackTool({ projectDir: work, templateId: 'react' })].filter(Boolean) as import('@cascade/core').Tool[],
	})
	const t0 = Date.now()
	let timedOut = false
	let stage: CascadeSession | undefined
	const timer = setTimeout(() => {
		timedOut = true
		stage?.abort()
		session.abort()
	}, args['timeout-ms'] ? Number(args['timeout-ms']) : scenario.budgets.timeoutMs)
	const prompts = scenario.prompts ?? [scenario.prompt!]
	try {
		// ADR-056 rung 3 FIDELITY: same deterministic plan stage as the product (wsServer submit path) —
		// fresh project + no PLAN.md + proactive planner ⇒ the planner runs as its own top-level session on
		// the FIRST prompt, auto-answered like every other question in the bench. Separate trace file so
		// stage forensics don't interleave with the builder's.
		const plannerDef = needsPlanStage(work, 0, agentDirs)
		if (plannerDef) {
			process.stdout.write('P')
			const planner = createPlannerSession(plannerDef, {
				dir: work,
				provider,
				model: args.model!,
				skillDirs,
				tracer: otel ? fanout(new JsonlTracer(join(runDir, 'traces', `${id}-planner.jsonl`)), otel) : new JsonlTracer(join(runDir, 'traces', `${id}-planner.jsonl`)),
				contextWindow: args['context-window'] ? Number(args['context-window']) : scenario.session?.contextWindow,
				maxOutputTokens: scenario.session?.maxOutputTokens,
			})
			stage = planner
			try {
				for await (const ev of planner.submit(prompts[0]!)) {
					if (ev.type === 'toolStart') process.stdout.write('.')
					else if (ev.type === 'question') planner.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
					else if (ev.type === 'permission') planner.respondPermission(ev.id, 'allow')
				}
				// FIDELITY (wsServer submit path): the spoken-questions salvage — when the stage ended with no
				// plan and no question asked, ONE nudge round names the protocol violation and re-runs.
				if (!timedOut && !ensurePlanPersisted(work, planner)) {
					process.stdout.write('p')
					for await (const ev of planner.submit(planSalvageNudge(planner))) {
						if (ev.type === 'toolStart') process.stdout.write('.')
						else if (ev.type === 'question') planner.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
						else if (ev.type === 'permission') planner.respondPermission(ev.id, 'allow')
					}
				}
			} finally {
				stage = undefined
				ensurePlanPersisted(work, planner) // guarantee PLAN.md exists (from the write, or the final message)
				await planner.dispose().catch(() => {})
			}
		}
		for (let i = 0; i < prompts.length; i++) {
			if (timedOut) break
			if (i > 0) process.stdout.write('|') // stage separator: one bar per follow-up prompt
			for await (const ev of session.submit(prompts[i]!)) {
				if (ev.type === 'toolStart') process.stdout.write('.')
				else if (ev.type === 'question') session.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
				else if (ev.type === 'permission') session.respondPermission(ev.id, 'allow')
			}
		}
	} catch {
		/* abort may throw; the row records timedOut */
	} finally {
		clearTimeout(timer)
		await session.dispose().catch(() => {})
		await otel?.shutdown().catch(() => {}) // flush spans before the next scenario / exit
	}
	const wallMs = Date.now() - t0
	const check = runCheck(id, work)
	if (args.keep) console.log(`\n   workdir kept for replay → ${work}`)
	else cleanup(work)

	const row = { ts: new Date().toISOString(), label, model: args.model, scenario: id, solved: check.ok, timedOut, wallMs, traceFile: `${id}.jsonl`, ...(args.keep ? { workdir: work } : {}) }
	appendFileSync(join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`)
	console.log(` ${check.ok ? '✅' : timedOut ? '⏱ timeout' : '❌'}  ${Math.round(wallMs / 1000)}s${check.ok ? '' : `\n   ${check.output.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`}`)
}
awake.release() // let the machine sleep again
console.log(`\nresults → ${runDir}`)
