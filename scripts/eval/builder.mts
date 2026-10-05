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
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, type ActivityEvent, type CascadeSession, type ModelProvider, type SessionOptions } from '@cascade/core'
// ADR-085 P0: the bench builds its sessions and plan stage from the SAME functions as the product.
import { builderSessionOptions, plannerSessionFor, runBuilderTurn, runPlanStage, type ActiveModel } from '../../packages/server/src/builderSession'
import { needsPlanStage } from '../../packages/server/src/planStage'
import { HostSandbox } from '../../packages/server/src/hostSandbox'
import { hasVision } from '../../packages/server/src/modelCaps'
import { readAiRules, stampStart, templateCopyFilter } from '../../packages/server/src/templates'
import { builtPreset, installSeed, loadSeed, pinPlanPreset } from './designSeed.mts'
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
		// Run every scenario N times (pass-rate cells). Measured need (wave1 vs wave1-v2, 2026-08-23): the
		// same scenario flipped verdict on consecutive days at BOTH tiers — a single run is a coin flip, so
		// a matrix cell is only signal as a rate over ≥3 attempts.
		repeats: { type: 'string', default: '1' },
		// Survive the launching session closing. Measured TWICE: a background run whose owning shell died
		// orphaned mid-flight — the runner wedged writing progress dots to the dead stdout pipe BEFORE the
		// first trace event, while keep-awake held the box up for ~24h. --detach re-spawns the runner as its
		// own detached process with stdout/stderr on a FILE (file writes can't block on a dead reader);
		// progress is then observable via <runDir>/runner.log + traces, completion via results.jsonl.
		detach: { type: 'boolean', default: false },
		// ADR-083 A/B treatment arm: a third-party skill FOLDER to adopt as-is. It is copied into every
		// workdir's .cascade/skills/<name>/ (the builder's Bash can only reach the project, and its scripts
		// must be runnable), and the builder is told to load it before its first write — the same mandate
		// architecture/design get. Everything else stays identical to the control arm.
		'extra-skill': { type: 'string' },
		// (ADR-083's research-only --free-brief arm retired into the product's None start: --template none.)
		// Prompt overrides: a dir holding `<scenario id>.txt` (single-shot) used instead of scenario.json's.
		'prompt-dir': { type: 'string' },
		// ADR-085 P0 oracle: a seeds root holding `<scenario id>/seed.json` (eval/design-seeds). B arm = the
		// seed's theme + fonts, active before the session exists, and PLAN.md's preset pinned to it after the
		// plan stage; --design-brief adds its DESIGN.md (the C arm). Scenarios without a seed run unseeded.
		'design-seed': { type: 'string' },
		'design-brief': { type: 'boolean', default: false },
		// ADR-086: the project's START — `react` (the template) or `none` (a blank project: no scaffold and no
		// shared node_modules, so the model scaffolds and `npm install`s itself, exactly as in the product).
		template: { type: 'string', default: 'react' },
		// ADR-086: comma-separated image files attached to the FIRST prompt — the planner studies them (on a
		// model with vision, as the product decides) before the plan, and the first builder turn gets them too.
		images: { type: 'string' },
		'max-turns': { type: 'string' },
		// ADR-086 P2: follow-up rounds to "done". A local model may need more than one turn to finish; after the
		// scenario's prompts the product's check runs, and a failure goes back as the next prompt, up to N times.
		// Counted in the row (followups, solvedFirst), never gated.
		followups: { type: 'string' },
	},
})
if (args['design-brief'] && !args['design-seed']) {
	console.error('--design-brief is the C arm of the oracle: it needs --design-seed')
	process.exit(2)
}
if (args.template !== 'react' && args.template !== 'none') {
	console.error(`--template must be react or none (got "${args.template}")`)
	process.exit(2)
}
if (args.template === 'none' && args['design-seed']) {
	console.error('--template none is a BLANK project: --design-seed needs the React template')
	process.exit(2)
}
// The attachments as the product sends them: data URIs.
const firstImages = args.images
	? args.images.split(',').map((f) => `data:image/${/\.jpe?g$/i.test(f) ? 'jpeg' : /\.webp$/i.test(f) ? 'webp' : 'png'};base64,${readFileSync(f.trim()).toString('base64')}`)
	: undefined

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
	/** Long-ladder instrumentation: run check.mjs after EVERY round with EVAL_ROUND=<n> (the check asserts
	 *  only rounds ≤ n) and record a per-round verdict in results.jsonl. This is what turns a multi-day
	 *  incremental scenario into a DEGRADATION CURVE — where the build broke, not just whether it survived.
	 *  The check must be round-MONOTONIC: round n's assertions all still hold at n+1 (verify enforces it
	 *  by running the solution against every round's bar). */
	checkEachRound?: boolean
	/** CLOSED-LOOP variant (measured need, fullstack-iq3-32k-v2 2026-08-22: a missing line-items editor
	 *  stayed ✗ for EIGHT rounds because checkpoint verdicts are runner-side — the model never learns a
	 *  round failed, so a stuck defect stays stuck). With this flag, a failed checkpoint's tail is appended
	 *  to the NEXT round's prompt as a system-reminder, mirroring the product's verify/audit feedback gates.
	 *  Off = pure measurement (what the model does unaided); on = measures SELF-CORRECTION instead. */
	checkFeedback?: boolean
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
	if (args.template === 'none') {
		// ADR-086: what ProjectManager.create(…, 'none') makes — a .gitignore and the stamp, nothing else.
		writeFileSync(join(work, '.gitignore'), 'node_modules\ndist\n')
		stampStart(work, 'none')
		return work
	}
	// The PRODUCT's filter, not a local copy of it: a raw recursive copy handed every run the template's
	// `demo/` — complete reference implementations of the exact scenarios under test — and choked the
	// junction below on a stray `node_modules`. The bench must scaffold what applyTemplate ships.
	cpSync(TEMPLATE, work, { recursive: true, filter: templateCopyFilter })
	symlinkSync(SHARED_DEPS, join(work, 'node_modules'), 'junction')
	return work
}

/**
 * Free the dev port between scenarios — and, for iterative scenarios, the whole VITE RANGE between rounds.
 *
 * Models verify their work by starting a dev server, and they background it: `nohup npm run dev &`. That
 * server OUTLIVES the scenario — session.dispose() ends the agent, not a process the agent detached. Two
 * consecutive matrix runs (2026-08-15) died on this: an orphan from one scenario kept :5173, and the bench
 * went silent right after the turn that spawned it, taking the queued scenarios with it.
 *
 * The ROUND-scale variant of the same leak (measured 2026-08-22, fullstack ladder): a 12-round session
 * re-spawns `npm run dev` nearly every round, each new vite finds 5173 taken and auto-increments — 26
 * pollers were listening on 5173–5198 by round 5, burning CPU against ollama's prefill and teaching the
 * model port-confusion. So a checkEachRound scenario reaps 5173..5200 at every checkpoint. The app's API
 * server (:8787) is deliberately NOT reaped between rounds — the model treats it as long-lived state; it
 * dies with the scenario-end reap.
 *
 * Killing by PORT is the targeted move — the one thing the model itself is refused, because `taskkill /IM
 * node.exe` (measured, same day) takes down the harness and the user's editor along with the server. Here
 * we know exactly which listener to end.
 */
function reapDevServer(ports: number | number[] = 5173): void {
	const wanted = new Set(Array.isArray(ports) ? ports : [ports])
	try {
		if (process.platform === 'win32') {
			// ONE netstat scan for however many ports — a 28-port range at every checkpoint must not mean
			// 28 process spawns.
			const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
			const pids = new Set(
				out
					.split('\n')
					.filter((l) => l.includes('LISTENING') && [...wanted].some((p) => l.includes(`:${p} `)))
					.map((l) => l.trim().split(/\s+/).pop()!)
					.filter((p) => /^\d+$/.test(p) && p !== '0'),
			)
			for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
		} else {
			const out = spawnSync('lsof', ['-t', ...[...wanted].map((p) => `-i:${p}`)], { encoding: 'utf8' }).stdout ?? ''
			for (const pid of out.split('\n').filter(Boolean)) spawnSync('kill', ['-9', pid.trim()], { stdio: 'ignore' })
		}
	} catch {
		/* best effort — a surviving dev server is a slow next scenario, not a broken one */
	}
}

/** The vite auto-increment range a long session can sprawl across (5173 + one per orphaned re-spawn). */
const VITE_RANGE = Array.from({ length: 28 }, (_, i) => 5173 + i)

/**
 * Post-run screenshot (design-overhaul P4 tail): every run leaves a picture for human judgment, pass OR
 * fail — assertions catch structure, but "does it LOOK designed" is still a human call. BEST-EFFORT by
 * contract: any failure logs one line and never touches the verdict. Serves the dist/ the check already
 * built via `vite preview`, shoots light and dark (the design pass reviews both), reaps the preview by
 * PID. Uses playwright-core over the system browser channel — zero new dependencies (browserTool's own
 * pattern; a fresh checkout without Edge/Chrome simply skips).
 */
async function captureScreenshots(work: string, outDir: string, id: string): Promise<void> {
	const port = 4173
	let preview: import('node:child_process').ChildProcess | undefined
	try {
		if (!existsSync(join(work, 'dist', 'index.html'))) return // check never built — nothing to shoot
		mkdirSync(outDir, { recursive: true })
		preview = spawn(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: work, stdio: 'ignore' })
		await new Promise((r) => setTimeout(r, 2500))
		const { chromium } = await import('playwright-core')
		let browser: import('playwright-core').Browser | undefined
		for (const channel of ['msedge', 'chrome'] as const) {
			try {
				browser = await chromium.launch({ channel, headless: true })
				break
			} catch {
				/* channel not installed — try the next */
			}
		}
		if (!browser) return
		try {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
			await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 15_000 })
			await page.screenshot({ path: join(outDir, `${id}-light.png`) })
			await page.evaluate("document.documentElement.classList.add('dark')")
			await page.waitForTimeout(300)
			await page.screenshot({ path: join(outDir, `${id}-dark.png`) })
			console.log(`   📷 ${join(outDir, `${id}-{light,dark}.png`)}`)
		} finally {
			await browser.close().catch(() => {})
		}
	} catch (e) {
		console.log(`   (screenshot skipped: ${e instanceof Error ? e.message.split('\n')[0] : e})`)
	} finally {
		if (preview?.pid) {
			if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore' })
			else preview.kill('SIGKILL')
		}
		reapDevServer(port) // belt over braces — --strictPort means anything left listening is ours
	}
}

function runCheck(id: string, work: string, round?: number, collect = false): { ok: boolean; output: string } {
	// EVAL_ROUND gates a checkEachRound scenario's assertions to "everything asked so far"; unset = full bar.
	// EVAL_COLLECT asks the check for ALL failing assertions (the feedback loop needs the full findings
	// list — single-error feedback measurably induced whack-a-mole, fullstack-v3 2026-08-23).
	const env = { ...process.env, ...(round === undefined ? {} : { EVAL_ROUND: String(round) }), ...(collect ? { EVAL_COLLECT: '1' } : {}) }
	const res = spawnSync(process.execPath, [join(SCENARIOS_DIR, id, 'check.mjs')], { cwd: work, encoding: 'utf8', timeout: 300_000, env })
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
		// checkEachRound scenarios: the solution must pass EVERY round's bar, not just the final one —
		// this is what pins round-MONOTONICITY (a round-n assertion that the finished app violates would
		// mark healthy late rounds ✗ in a live run and corrupt the degradation curve).
		const scen: Scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, id, 'scenario.json'), 'utf8'))
		let roundBad: { n: number; output: string } | undefined
		if (sol.ok && scen.checkEachRound && scen.prompts) {
			for (let n = 1; n <= scen.prompts.length; n++) {
				const r = runCheck(id, solWork, n)
				if (!r.ok) {
					roundBad = { n, output: r.output }
					break
				}
			}
		}
		cleanup(solWork)
		const ok = !seed.ok && sol.ok && !roundBad
		if (!ok) {
			bad++
			const why = seed.ok ? 'seed unexpectedly PASSED' : roundBad ? `solution FAILS at round ${roundBad.n} bar` : 'solution FAILED'
			console.error(`--- ${id}: ${why} ---\n${(seed.ok ? seed.output : (roundBad?.output ?? sol.output)).slice(-1200)}`)
		}
		console.log(`${id}: seed-fails ${!seed.ok ? '✅' : '❌'} · solution-passes ${sol.ok ? '✅' : '❌'}${scen.checkEachRound && scen.prompts ? ` · all-round-bars ${!sol.ok ? '(skipped)' : roundBad ? `❌ (r${roundBad.n})` : '✅'}` : ''}`)
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

/** The bench has no human: answer each question with its first option, approve each permission, and print
 *  one progress dot per tool call. Used for the plan stage and every builder round alike. */
const autoAnswer = (s: CascadeSession) => (ev: ActivityEvent) => {
	if (ev.type === 'toolStart') process.stdout.write('.')
	else if (ev.type === 'question') s.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
	else if (ev.type === 'permission') s.respondPermission(ev.id, 'allow')
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

/** ADR-083 A/B treatment: install `skillDir` into the workdir's own skills dir and return the mandate line
 *  appended to the builder's instructions ('' when no extra skill was requested). The ONLY content change
 *  is the path rewrite: `${CLAUDE_PLUGIN_ROOT}` exists only in the skill's plugin-host install, not here,
 *  so its script paths are pointed at the in-project copy. */
function installExtraSkill(work: string, skillDir: string | undefined): string {
	if (!skillDir) return ''
	const name = basename(skillDir)
	const rel = `.cascade/skills/${name}`
	const dest = join(work, '.cascade', 'skills', name)
	cpSync(skillDir, dest, { recursive: true })
	const rewrite = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name)
			if (entry.isDirectory()) rewrite(p)
			else if (entry.name.endsWith('.md'))
				writeFileSync(p, readFileSync(p, 'utf8').replaceAll(`\${CLAUDE_PLUGIN_ROOT}/.claude/skills/${name}`, rel))
		}
	}
	rewrite(dest)
	return (
		`\n\nThis project adopts the "${name}" skill as its UI/UX design guide. Before your first Write or Edit, ` +
		`load Skill {name: "${name}"} — mandatory, like architecture and design — and follow its workflow. ` +
		`Its scripts are inside the project at ${rel}/scripts/; run them from the project root with \`python\`.`
	)
}

writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ label, model: args.model, tier: 'builder', scenarios: wanted, extraSkill: args['extra-skill'] ?? null, designSeed: args['design-seed'] ?? null, designBrief: args['design-brief'] ?? false, template: args.template, images: args.images ?? null, followups: Number(args.followups) || 0, contextWindow: args['context-window'] ?? null, startedAt: new Date().toISOString() }, null, '\t'))
console.log(`builder bench "${label}" — model=${args.model} scenarios=${wanted.length}\n`)
// Builder scenarios (esp. iterate) run far past the 60-min sleep/hibernate threshold — hold the box awake.
// keepAwake self-reaps on process exit; release() is called explicitly after the run loop below.
const awake = keepAwake()
// ADR-085: vision comes from the model's own capabilities, exactly as the product resolves it (hasVision) —
// not the hard-coded `true` the free arm used, which would hand a text-only model screenshots it can't read.
const vision = await hasVision(args.model!, args['base-url'], args.provider!).catch(() => false)

const repeats = Math.max(1, Number(args.repeats) || 1)
for (const id of wanted) {
for (let attempt = 1; attempt <= repeats; attempt++) {
	// Attempt-scoped identity: with repeats>1 every artifact (trace, planner trace, screenshots, row)
	// carries `-aN`, so attempts never overwrite each other.
	const runId = repeats > 1 ? `${id}-a${attempt}` : id
	const scenario: Scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, id, 'scenario.json'), 'utf8'))
	const work = makeWorkdir(id)
	const skillMandate = installExtraSkill(work, args['extra-skill']) // ADR-083 A/B treatment ('' = control)
	// ADR-085 oracle: seed BEFORE the session exists (Restyle's preset list and AI_RULES are read at creation).
	const seed = args['design-seed'] ? loadSeed(args['design-seed'], id) : undefined
	if (seed) installSeed(work, seed, args['design-brief']!)
	else if (args['design-seed']) console.warn(`(no design seed for ${id} under ${args['design-seed']} — this scenario runs unseeded)`)
	let seedPin: ReturnType<typeof pinPlanPreset> | undefined
	const tracePath = join(runDir, 'traces', `${runId}.jsonl`)
	process.stdout.write(`▶ ${runId} `)

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

	// ADR-085 P0 — FIDELITY BY CONSTRUCTION: the product's builder session, built by the product's own function
	// (Browser, ImageSearch, AI_RULES.md, excluded tools, the 'auto' output cap, skills, agents — per start).
	// The bench differs ONLY in BenchDifferences: no curation into the user's global memory between runs, and
	// the scenario's turn budget. The runtime is HostSandbox, the product's default (ADR-081).
	const active: ActiveModel = {
		provider: args.provider!,
		model: args.model!,
		baseUrl: args['base-url'],
		contextWindow: args['context-window'] ? Number(args['context-window']) : scenario.session?.contextWindow,
		maxOutputTokens: scenario.session?.maxOutputTokens,
	}
	const sandbox = new HostSandbox(work)
	const productOptions = builderSessionOptions(
		{
			dir: work,
			provider,
			active,
			sandbox,
			vision,
			tracer: otel ? fanout(new JsonlTracer(tracePath), otel) : new JsonlTracer(tracePath),
			// The template's AI rules, as the product injects them — plus the A/B treatment's skill mandate, if any.
			extraInstructions: [readAiRules(work), skillMandate.trim()].filter(Boolean).join('\n\n'),
		},
		{ autoMemory: false, maxTurns: args['max-turns'] ? Number(args['max-turns']) : scenario.budgets.maxTurns },
	)
	const options: SessionOptions = productOptions
	const session = createSession(options)
	const t0 = Date.now()
	let timedOut = false
	const rounds: { n: number; ok: boolean; ms: number; note?: string }[] = []
	const followups = Math.max(0, Number(args.followups) || 0)
	let followupsUsed = 0
	let solvedFirst: boolean | undefined
	let stage: CascadeSession | undefined
	const timer = setTimeout(() => {
		timedOut = true
		stage?.abort()
		session.abort()
	}, args['timeout-ms'] ? Number(args['timeout-ms']) : scenario.budgets.timeoutMs)
	const prompts = args['prompt-dir'] ? [readFileSync(join(args['prompt-dir'], `${id}.txt`), 'utf8')] : (scenario.prompts ?? [scenario.prompt!])
	try {
		// ADR-056 rung 3 + ADR-085: the product's plan stage, run by the product's own function — fresh project +
		// no PLAN.md + proactive planner ⇒ the planner runs first on the FIRST prompt (auto-answered here), with
		// the same salvage/revise round. Separate trace file so stage forensics don't interleave with the builder's.
		const plannerDef = needsPlanStage(work, 0, options.agentDirs ?? [])
		if (plannerDef) {
			process.stdout.write('P')
			const plannerTrace = new JsonlTracer(join(runDir, 'traces', `${runId}-planner.jsonl`))
			const planner = plannerSessionFor(plannerDef, { dir: work, provider, active, sandbox, tracer: otel ? fanout(plannerTrace, otel) : plannerTrace })
			stage = planner
			try {
				// ADR-086, as wsServer does it: the planner studies attached images only on a model with vision; a
				// text-only one is told they exist and were not seen.
				const planPrompt = firstImages && !vision ? `${prompts[0]!}\n\n(The user attached ${firstImages.length} image${firstImages.length > 1 ? 's' : ''}, but this model cannot view images: plan from the text, and note in the plan that the images were not seen.)` : prompts[0]!
				await runPlanStage(work, planner, planPrompt, { onEvent: autoAnswer(planner), onStatus: () => process.stdout.write('r'), aborted: () => timedOut }, vision ? firstImages : undefined)
			} finally {
				stage = undefined
			}
		}
		// The planner picks a preset from the menu (premium, by habit); the oracle's seed must win, as P1's
		// applyPlanDesign() will make the server's choice win in the product.
		if (seed) seedPin = pinPlanPreset(work, seed.id)
		let pendingFeedback: string | undefined
		for (let i = 0; i < prompts.length; i++) {
			if (timedOut) break
			if (i > 0) process.stdout.write('|') // stage separator: one bar per follow-up prompt
			const roundStart = Date.now()
			// checkFeedback: a failed checkpoint rides into the next round as a reminder (see the flag doc).
			const roundPrompt =
				pendingFeedback && scenario.checkFeedback
					? `${prompts[i]!}\n\n<system-reminder>The automated checkpoint after your PREVIOUS round FAILED:\n${pendingFeedback}\nFix that first — it stays broken until you do — then complete this round's work. The checkpoint re-runs after every round.</system-reminder>`
					: prompts[i]!
			// The product's builder turn (P2's post-turn design check lands in it); no runtime — the bench's
			// workdirs share a pre-installed node_modules, so there is nothing to install.
			await runBuilderTurn(session, roundPrompt, { onEvent: autoAnswer(session) }, { images: i === 0 ? firstImages : undefined })
			if (scenario.checkEachRound && !timedOut) {
				// Reap the round's vite orphans BEFORE the checkpoint (see reapDevServer's round-scale note).
				reapDevServer(VITE_RANGE)
				// Checkpoint: the round's bar, recorded even when later rounds will fail — the whole point of
				// a multi-day ladder is knowing WHICH increment broke (and whether an earlier one regressed).
				const rc = runCheck(id, work, i + 1, scenario.checkFeedback)
				rounds.push({ n: i + 1, ok: rc.ok, ms: Date.now() - roundStart, ...(rc.ok ? {} : { note: rc.output.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200) }) })
				if (!rc.ok) {
					// The 200-char note is for the results row; the FULL output is forensic evidence — a check
					// that crashes must never be undiagnosable because its stack was truncated to a footer
					// (measured: v4's r3–r11 notes were all "| Node.js v24.14.1" and nothing else survived).
					mkdirSync(join(runDir, 'checks'), { recursive: true })
					writeFileSync(join(runDir, 'checks', `${runId}-r${i + 1}.log`), rc.output)
				}
				// Feedback = the check's CUMULATIVE findings block, minus instrument-crash lines (a crashed
				// check is our fault, never presented to the model as its defect).
				const block = rc.output.match(/FAILING \(\d+\):[\s\S]*$/)?.[0] ?? rc.output.split('\n').filter(Boolean).slice(-3).join('\n')
				const findings = block.split('\n').filter((l) => !/instrument crashed/i.test(l))
				pendingFeedback = rc.ok || findings.filter((l) => l.startsWith('- ')).length === 0 ? undefined : findings.join('\n').slice(0, 900)
				process.stdout.write(rc.ok ? '✓' : '✗')
			}
		}
		// ADR-086 P2 — follow-up rounds to done, while the session (and its context) is still alive: the product's
		// check runs; a failure goes back as the next turn with the check's own words. The last run of the check
		// (after the finally) is the verdict; the first one says whether a single turn was enough.
		for (let k = 0; followups > 0 && k <= followups && !timedOut; k++) {
			const rc = runCheck(id, work)
			solvedFirst ??= rc.ok
			if (rc.ok || k === followups) break
			followupsUsed++
			process.stdout.write('+')
			const failing = rc.output.split('\n').filter((l) => l.trim() && !/instrument crashed/i.test(l)).slice(-14).join('\n').slice(0, 1500)
			await runBuilderTurn(session, `The app is not done yet — the automated check fails:\n${failing}\n\nFix every item above, run \`npm run build\` until it is green, and check the running app again before you finish.`, { onEvent: autoAnswer(session) })
		}
	} catch {
		/* abort may throw; the row records timedOut */
	} finally {
		clearTimeout(timer)
		await session.dispose().catch(() => {}) // closes the Browser tool's headless browser (Tool.dispose)
		// The Browser tool's dev server: HostSandbox serves on an OS-assigned port, outside the reap range below —
		// measured (ADR-086 P0), it outlived every run and, with the browser, kept the bench from exiting.
		await sandbox.dispose().catch(() => {})
		reapDevServer([...VITE_RANGE, 8787]) // …and anything the model left listening — incl. the app's API server (scenario-lifetime state; it ends here)
		await otel?.shutdown().catch(() => {}) // flush spans before the next scenario / exit
	}
	const wallMs = Date.now() - t0
	const check = runCheck(id, work)
	// The seed's survival, read from what was BUILT (the check just ran vite build): a run that drifted back to
	// a shipped preset is excluded from the oracle comparison and counted.
	const built = seed ? builtPreset(work) : undefined
	const seedRow = seed ? { seed: { id: seed.id, brief: args['design-brief'], pin: seedPin ?? 'no-plan', built: built ?? null, kept: built === seed.id } } : {}
	await captureScreenshots(work, join(runDir, 'shots'), runId) // best-effort, pass or fail — never the verdict
	if (args.keep) console.log(`\n   workdir kept for replay → ${work}`)
	else cleanup(work)

	const row = { ts: new Date().toISOString(), label, model: args.model, scenario: id, ...(repeats > 1 ? { attempt } : {}), solved: check.ok, timedOut, wallMs, traceFile: `${runId}.jsonl`, ...(rounds.length ? { rounds } : {}), ...(followups ? { followups: followupsUsed, solvedFirst: solvedFirst ?? false } : {}), ...seedRow, ...(args.keep ? { workdir: work } : {}) }
	appendFileSync(join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`)
	console.log(` ${check.ok ? '✅' : timedOut ? '⏱ timeout' : '❌'}  ${Math.round(wallMs / 1000)}s${check.ok ? '' : `\n   ${check.output.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`}`)
}
}
awake.release() // let the machine sleep again
console.log(`\nresults → ${runDir}`)
