// scripts/eval/run.mts — the Tier-1 eval runner (PLAN-eval E3).
//
//   npx tsx scripts/eval/run.mts --model <ollama-model> [--label mylabel] [--tasks a,b] [--trials 1]
//                               [--provider ollama] [--base-url http://127.0.0.1:11434] [--temperature 0]
//
// Per task × trial: copy the fixture repo to a temp dir → drive a REAL headless CascadeSession against it
// (permissions bypassed, budgets enforced, JSONL trace captured) → restore `protected` paths from the fixture
// (an agent that edited the tests can't game the check) → run the task's check → append one row to
// eval/runs/<label>/results.jsonl. The trace is the diagnosis artifact; the analyzer (E4) classifies failures.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, type ModelProvider } from '@cascade/core'

// ── args ─────────────────────────────────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
	options: {
		model: { type: 'string' },
		label: { type: 'string' },
		tasks: { type: 'string' }, // csv of task ids; default = all
		trials: { type: 'string', default: '1' },
		provider: { type: 'string', default: 'ollama' },
		'base-url': { type: 'string' },
		temperature: { type: 'string', default: '0' }, // determinism by default (PLAN-eval ground rules)
		'tasks-dir': { type: 'string' }, // Tier-2: point at a converted external suite (e.g. eval/external/tasks-js)
	},
})
if (!args.model) {
	console.error('usage: npx tsx scripts/eval/run.mts --model <model> [--label L] [--tasks a,b] [--trials N]')
	process.exit(2)
}

const ROOT = join(import.meta.dirname, '..', '..')
const TASKS_DIR = args['tasks-dir'] ? resolve(ROOT, args['tasks-dir']) : join(ROOT, 'eval', 'tasks')
const label = args.label ?? `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${args.model!.replace(/[^a-z0-9.-]/gi, '_')}`
const runDir = join(ROOT, 'eval', 'runs', label)
const tracesDir = join(runDir, 'traces')
mkdirSync(tracesDir, { recursive: true })

interface TaskSpec {
	id: string
	tags: string[]
	prompt: string
	check: string
	budgets: { maxTurns: number; timeoutMs: number }
	protected?: string[]
	session?: { contextWindow?: number; maxOutputTokens?: number }
}

const allIds = readdirSync(TASKS_DIR).filter((d) => existsSync(join(TASKS_DIR, d, 'task.json')))
const wanted = args.tasks ? args.tasks.split(',').map((s) => s.trim()) : allIds
const unknown = wanted.filter((id) => !allIds.includes(id))
if (unknown.length) {
	console.error(`unknown task(s): ${unknown.join(', ')}\navailable: ${allIds.join(', ')}`)
	process.exit(2)
}
const trials = Number(args.trials)

// ── provider: decorate with the eval temperature (keeps core untouched — the provider is an injected seam) ─
function withTemperature(p: ModelProvider, temperature: number): ModelProvider {
	return {
		id: p.id,
		complete: (req, sig) => p.complete({ ...req, temperature }, sig),
		stream: (req, sig) => p.stream({ ...req, temperature }, sig),
		...(p.embed ? { embed: p.embed.bind(p) } : {}),
		...(p.detectModelLimits ? { detectModelLimits: p.detectModelLimits.bind(p) } : {}),
	}
}

// ── trace → metrics (cheap inline subset; full failure classification is the E4 analyzer's job) ───────────
function traceMetrics(tracePath: string) {
	const m = { turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, usageReported: false, compactions: [] as { kind: string; forced: boolean }[], recoveries: 0, backendFailed: false }
	if (!existsSync(tracePath)) return m
	for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
		if (!line.trim()) continue
		let e: any
		try {
			e = JSON.parse(line)
		} catch {
			continue
		}
		if (e.t === 'model_request') m.turns++
		else if (e.t === 'tool_call') m.toolCalls++
		else if (e.t === 'tool_result' && e.ok === false) m.toolErrors++
		else if (e.t === 'model_response' && e.usage) {
			m.usageReported = true
			m.inputTokens += e.usage.inputTokens ?? 0
			m.outputTokens += e.usage.outputTokens ?? 0
		} else if (e.t === 'compaction') m.compactions.push({ kind: e.kind, forced: e.forced })
		else if (e.t === 'error' && typeof e.message === 'string' && e.message.startsWith('recover(')) m.recoveries++
		else if (e.t === 'error' && typeof e.message === 'string' && /kept failing|HTTP 5\d\d|terminated/i.test(e.message)) m.backendFailed = true // same signature the classifier keys on
	}
	return m
}

// ── backend health (local backends only) ────────────────────────────────────────────────────────────────
// A crashed Ollama turns every remaining task into a ~4-minute retry storm misreported as a task failure
// (observed live: llama-server 0xc0000409 mid-suite). So: before each task, poll the backend until it
// answers; give it time to come back (Ollama restarts its runner on demand), and fail the RUN loudly —
// not the task silently — if it never does.
const HEALTH_URLS: Record<string, string> = { ollama: 'http://127.0.0.1:11434', llamacpp: 'http://127.0.0.1:8080' }
async function waitForBackend(): Promise<void> {
	const base = args['base-url'] ?? HEALTH_URLS[args.provider!]
	if (!base) return // hosted provider — no local health endpoint to poll
	for (let attempt = 1; attempt <= 24; attempt++) {
		try {
			// /api/tags proves only the DAEMON is up — a crashed llama-server still answers it (observed live).
			// The real probe is a 1-token generate: it forces the model runner to load and produce.
			const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) })
			if (tags.ok) {
				const probe = await fetch(`${base}/v1/chat/completions`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: args.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
					signal: AbortSignal.timeout(120_000), // cold model load can take a while
				})
				if (probe.ok) return
			}
		} catch {
			/* backend down or probe timed out — keep waiting */
		}
		if (attempt === 1) process.stdout.write('⌛ backend not generating, waiting…')
		await new Promise((r) => setTimeout(r, 5_000))
	}
	console.error('\nbackend never came back — aborting the run (rows so far are preserved)')
	process.exit(1)
}

// ── one task × one trial ─────────────────────────────────────────────────────────────────────────────────
async function runTrial(task: TaskSpec, trial: number, attempt = 1) {
	const work = mkdtempSync(join(tmpdir(), `cascade-eval-${task.id}-`))
	// A backend-crash retry gets its OWN trace file (JsonlTracer appends — reusing the name would interleave
	// two attempts). The row carries `traceFile` so the analyzer always reads the right one.
	const traceFile = `${task.id}-t${trial}${attempt > 1 ? `-r${attempt - 1}` : ''}.jsonl`
	const tracePath = join(tracesDir, traceFile)
	cpSync(join(TASKS_DIR, task.id, 'repo'), work, { recursive: true })

	const provider = withTemperature(
		createProvider({ provider: args.provider!, model: args.model!, baseUrl: args['base-url'] }),
		Number(args.temperature),
	)
	const session = createSession({
		cwd: work,
		provider,
		model: args.model!,
		mode: 'bypass', // eval runs unattended — no permission prompts (fixtures are throwaway temp dirs)
		tracer: new JsonlTracer(tracePath),
		autoMemory: false, // determinism + speed: no end-of-turn curation side-queries
		maxTurns: task.budgets.maxTurns,
		contextWindow: task.session?.contextWindow,
		maxOutputTokens: task.session?.maxOutputTokens,
	})

	const t0 = Date.now()
	let timedOut = false
	let questionsAsked = 0
	const timer = setTimeout(() => {
		timedOut = true
		session.abort()
	}, task.budgets.timeoutMs)
	try {
		for await (const ev of session.submit(task.prompt)) {
			if (ev.type === 'toolStart') {
				process.stdout.write('.') // heartbeat so a long run visibly progresses
			} else if (ev.type === 'question') {
				// ADR-043: AskUserQuestion PARKS the loop on an answer. Evals are unattended — auto-answer every
				// question with its FIRST option (the "(Recommended) first" convention) so the run never hangs.
				// questionsAsked lands in the row: a model deferring decisions mid-eval is itself a signal.
				questionsAsked += ev.questions.length
				session.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
			} else if (ev.type === 'permission') {
				// Defense-in-depth: 'bypass' should never emit these, but a parked loop is the worst eval failure
				// mode — auto-allow rather than burn the whole task timeout.
				session.respondPermission(ev.id, 'allow')
			}
		}
	} catch {
		// an aborted turn may surface as a throw — the row records timedOut; the trace has the tail
	} finally {
		clearTimeout(timer)
		await session.dispose().catch(() => {})
	}
	const wallMs = Date.now() - t0

	// Restore protected paths from the fixture BEFORE checking — edits to the oracle don't count.
	for (const p of task.protected ?? []) {
		rmSync(join(work, p), { recursive: true, force: true })
		cpSync(join(TASKS_DIR, task.id, 'repo', p), join(work, p), { recursive: true })
	}
	const check = spawnSync(task.check, { cwd: work, shell: true, encoding: 'utf8', timeout: 120_000 })
	// Cleanup must NEVER kill the suite: on Windows a straggling child (observed: a zombie jest worker) can
	// hold the temp dir → EPERM (crashed a 48-task run at 21). Retry briefly, then leave the dir to the OS.
	try {
		rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
	} catch (e) {
		console.warn(`\n(cleanup left ${work}: ${e instanceof Error ? e.message.split('\n')[0] : e})`)
	}

	return {
		ts: new Date().toISOString(),
		label,
		model: args.model,
		task: task.id,
		tags: task.tags,
		trial,
		traceFile,
		solved: check.status === 0,
		checkExit: check.status,
		timedOut,
		wallMs,
		questionsAsked,
		...traceMetrics(tracePath),
	}
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────
writeFileSync(
	join(runDir, 'meta.json'),
	JSON.stringify({ label, model: args.model, provider: args.provider, baseUrl: args['base-url'] ?? null, temperature: Number(args.temperature), trials, tasks: wanted, tasksDir: TASKS_DIR, node: process.version, startedAt: new Date().toISOString() }, null, '\t'),
)
console.log(`eval run "${label}" — model=${args.model} tasks=${wanted.length} trials=${trials}\n→ ${runDir}\n`)

const rows: Awaited<ReturnType<typeof runTrial>>[] = []
const totalTrials = wanted.length * trials
let done = 0
for (const id of wanted) {
	const task: TaskSpec = JSON.parse(readFileSync(join(TASKS_DIR, id, 'task.json'), 'utf8'))
	for (let trial = 1; trial <= trials; trial++) {
		await waitForBackend() // don't grind retry storms against a crashed local backend
		process.stdout.write(`▶ [${++done}/${totalTrials}] ${id}${trials > 1 ? ` (t${trial})` : ''} `)
		let row = await runTrial(task, trial)
		// The backend died mid-task (not the model's fault): wait for it to come back and retry ONCE.
		// The crashed attempt's trace is kept (-r suffix distinguishes the retry's).
		if (row.backendFailed) {
			process.stdout.write(' 💥 backend crashed — retrying once ')
			await waitForBackend()
			row = await runTrial(task, trial, 2)
		}
		appendFileSync(join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`)
		rows.push(row)
		console.log(` ${row.solved ? '✅' : row.timedOut ? '⏱ timeout' : '❌'}  ${Math.round(row.wallMs / 1000)}s · ${row.turns} turns · ${row.toolCalls} tools (${row.toolErrors} err) · ${row.usageReported ? `${row.inputTokens}+${row.outputTokens} tok` : 'no usage'} · ${row.compactions.length} compactions`)
	}
}

const solved = rows.filter((r) => r.solved).length
console.log(`\n${solved}/${rows.length} solved`)
console.table(rows.map((r) => ({ task: r.task, trial: r.trial, solved: r.solved ? '✅' : '❌', s: Math.round(r.wallMs / 1000), turns: r.turns, tools: r.toolCalls, errs: r.toolErrors, tokens: r.usageReported ? r.inputTokens + r.outputTokens : '—', compact: r.compactions.length })))
process.exit(0)
