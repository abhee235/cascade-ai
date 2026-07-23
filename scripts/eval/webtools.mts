// scripts/eval/webtools.mts — WIRING SMOKE for the two web tools that live at DIFFERENT layers:
//   • WebFetch      — a built-in tool (toolRegistry.ts), always available.
//   • web SEARCH    — NOT built-in; provided by the Tavily MCP connector (ADR-071), advertised to the
//                     model as `mcp__Tavily__tavily_search` (MCP tools are namespaced mcp__<server>__<tool>).
//
// This is an INTEGRATION smoke, not a capability eval: it proves both tools are reachable in one session and
// that the model WILL invoke each when the task demands it. The assertion is on TOOL CALLS recorded in the
// trace (the JsonlTracer writes `{t:"tool_call", name}` per invocation) — pass = the trace contains BOTH a
// `WebFetch` call AND an `mcp__Tavily__*` call. Behavioural correctness of the answers is out of scope here.
//
//   TAVILY_API_KEY=tvly-... npx tsx scripts/eval/webtools.mts [--model qwen36-agentic] [--provider ollama]
//   # set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to also stream the run to Phoenix.
//
// Kept OUT of the builder tier on purpose: the builder bench asserts on the BUILT APP (vite build + bundle),
// and it does not wire MCP into its session — so it structurally cannot exercise a connector. This does.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createProvider, createSession, JsonlTracer, sdkConnect, type McpServerConfig } from '@cascade/core'
import { fanout, OtelTracer } from './otelTracer.mts'

const { values: args } = parseArgs({
	options: {
		model: { type: 'string', default: 'qwen36-agentic' },
		provider: { type: 'string', default: 'ollama' },
		'base-url': { type: 'string' },
		'timeout-ms': { type: 'string', default: '300000' },
		keep: { type: 'boolean', default: false },
	},
})

const KEY = process.env.TAVILY_API_KEY
if (!KEY) {
	console.error('TAVILY_API_KEY is required (the connector key). Set it in the env; it is never written to disk.')
	process.exit(2)
}

const ROOT = join(import.meta.dirname, '..', '..')
mkdirSync(join(ROOT, 'eval', '.work'), { recursive: true })
const work = mkdtempSync(join(ROOT, 'eval', '.work', 'webtools-'))
const tracePath = join(work, 'trace.jsonl')

// The Tavily connector, EXACTLY as the product stores it: clean endpoint + key applied as a query param via
// apiKeyIn (sdkConnect assembles the URL server-side). Named "Tavily" ⇒ tools become mcp__Tavily__*.
const mcpServers: Record<string, McpServerConfig> = {
	Tavily: { url: 'https://mcp.tavily.com/mcp/', apiKey: KEY, apiKeyIn: 'query:tavilyApiKey' },
}

const provider = createProvider({ provider: args.provider!, model: args.model!, baseUrl: args['base-url'] })
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
const otel = otelEndpoint ? new OtelTracer({ endpoint: otelEndpoint, service: `webtools:${args.model}`, attributes: { 'cascade.model': args.model! } }) : undefined

const session = createSession({
	cwd: work,
	provider,
	model: args.model!,
	mode: 'bypass', // no permission prompts (matches product sandboxed sessions); MCP tools auto-allow
	autoMemory: false,
	maxTurns: 12,
	mcpServers,
	mcpConnect: sdkConnect,
	tracer: otel ? fanout(new JsonlTracer(tracePath), otel) : new JsonlTracer(tracePath),
})

// The two-step forcing prompt: step 1 can ONLY be done by searching (the model can't know a live top result);
// step 2 explicitly names WebFetch so tool SELECTION is deterministic (this is a wiring test, not a
// tool-choice test). Both tools must fire for the task to be completable as written.
const PROMPT = [
	'Do these two steps in order and report what you find:',
	'1. Use the web search tool (tavily_search) to find the official URL of the Vite build tool documentation homepage.',
	'2. Then use the WebFetch tool (NOT the search tool) to fetch that exact URL, and quote the one-line tagline Vite uses to describe itself.',
	'You MUST use the search tool for step 1 and the WebFetch tool for step 2 — do not skip either, and do not answer from memory.',
].join('\n')

async function pollReady(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const s = session.mcpStatuses().find((x) => x.name === 'Tavily')
		if (s?.status === 'ready') {
			console.log(`  Tavily connected — ${s.toolNames.length} tools: ${s.toolNames.join(', ')}`)
			return true
		}
		if (s?.status === 'failed') {
			console.error(`  Tavily failed to connect: ${s.error}`)
			return false
		}
		await new Promise((r) => setTimeout(r, 500))
	}
	return false
}

function toolCallsInTrace(): string[] {
	const names: string[] = []
	for (const line of readFileSync(tracePath, 'utf8').trim().split('\n')) {
		try {
			const e = JSON.parse(line)
			if (e.t === 'tool_call' && e.name) names.push(e.name)
		} catch {}
	}
	return names
}

console.log(`webtools smoke — model=${args.model} provider=${args.provider}`)
let ok = false
try {
	console.log('  waiting for the Tavily connector to become ready…')
	if (!(await pollReady(45_000))) throw new Error('Tavily never became ready (connector not wired?)')

	const timer = setTimeout(() => session.abort(), Number(args['timeout-ms']))
	process.stdout.write('  running')
	try {
		for await (const ev of session.submit(PROMPT)) {
			if (ev.type === 'toolStart') process.stdout.write(`\n    → ${ev.name}`)
			else if (ev.type === 'question') session.respondQuestion(ev.id, Object.fromEntries(ev.questions.map((q) => [q.question, q.options[0]?.label ?? 'Other'])))
			else if (ev.type === 'permission') session.respondPermission(ev.id, 'allow')
		}
	} finally {
		clearTimeout(timer)
	}
	console.log()

	// ── Assertion: both layers fired ─────────────────────────────────────────────────────────────────────
	const calls = toolCallsInTrace()
	const fetched = calls.filter((n) => n === 'WebFetch')
	const searched = calls.filter((n) => n.startsWith('mcp__Tavily__'))
	console.log(`\n  tool calls (${calls.length}): ${calls.join(', ') || '(none)'}`)
	console.log(`  WebFetch (built-in):        ${fetched.length ? `✅ ${fetched.length}×` : '❌ never called'}`)
	console.log(`  mcp__Tavily__* (connector): ${searched.length ? `✅ ${searched.length}× (${[...new Set(searched)].join(', ')})` : '❌ never called'}`)
	ok = fetched.length > 0 && searched.length > 0
	console.log(`\n${ok ? '✅ PASS' : '❌ FAIL'} — both web tools ${ok ? 'were exercised in one session' : 'were NOT both called'}`)
} catch (e) {
	console.error(`\n❌ ERROR: ${e instanceof Error ? e.message : e}`)
} finally {
	await session.dispose().catch(() => {})
	await otel?.shutdown().catch(() => {})
	if (args.keep) console.log(`  trace kept → ${tracePath}`)
	else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
}
process.exit(ok ? 0 : 1)
