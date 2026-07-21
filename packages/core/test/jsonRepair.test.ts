// Item 4a — honest tool-arg parsing. The measured failure (invalid-args/prose-fallback 3B traces): almost-JSON
// arguments were swallowed to {} (`catch { input = {} }`), so the model was told "missing required file_path"
// — a lie about its own syntax error — and retried the identical call. Repair what's mechanical; be honest
// about the rest.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { RAW_ARGS_KEY, parseToolArgs } from '../src/llm/jsonRepair'
import { OllamaProvider } from '../src/llm/providers/ollama'
import { executeTool } from '../src/tools/runTool'
import type { ToolContext } from '../src/tools/Tool'

describe('parseToolArgs — the repair ladder', () => {
	it('clean paths: object passthrough, valid JSON string, empty → {}', () => {
		expect(parseToolArgs({ file_path: 'a.ts' })).toEqual({ input: { file_path: 'a.ts' }, via: 'exact' })
		expect(parseToolArgs('{"file_path":"a.ts"}')).toEqual({ input: { file_path: 'a.ts' }, via: 'exact' })
		expect(parseToolArgs('')).toEqual({ input: {}, via: 'exact' })
		expect(parseToolArgs(undefined)).toEqual({ input: {}, via: 'exact' })
	})

	it.each([
		['trailing comma', '{"file_path": "src/a.ts",}'],
		['code fence', '```json\n{"file_path": "src/a.ts"}\n```'],
		['surrounding prose', 'Here are the arguments: {"file_path": "src/a.ts"} — done.'],
		['unquoted keys', '{file_path: "src/a.ts"}'],
		['single quotes', "{'file_path': 'src/a.ts'}"],
		['truncated after value', '{"file_path": "src/a.ts", "limit": 5'],
		['truncated mid-string', '{"file_path": "src/a.ts'],
		['truncated dangling key', '{"file_path": "src/a.ts", "limit":'],
	])('repairs %s', (_name, raw) => {
		const r = parseToolArgs(raw)
		expect(r.via).toBe('repaired')
		expect((r.input as Record<string, unknown>).file_path).toBe('src/a.ts')
	})

	it('combined damage: fenced + unquoted keys + trailing comma', () => {
		const r = parseToolArgs('```json\n{file_path: "src/a.ts", limit: 5,}\n```')
		expect(r.via).toBe('repaired')
		expect(r.input).toEqual({ file_path: 'src/a.ts', limit: 5 })
	})

	it('honest failure: garbage and non-object payloads become the { __rawArgs } sentinel', () => {
		for (const raw of ['read the file please', '"src/a.ts"', '[1,2,3]', 'file_path = src/a.ts']) {
			const r = parseToolArgs(raw)
			expect(r.via).toBe('raw')
			expect((r.input as Record<string, unknown>)[RAW_ARGS_KEY]).toBeDefined()
		}
	})

	it('repair never invents content: a Bash command with quotes/braces survives byte-for-byte', () => {
		const cmd = `echo '{"a": 1,}' && grep "x'y" f.txt`
		const r = parseToolArgs(JSON.stringify({ command: cmd }))
		expect(r.via).toBe('exact')
		expect((r.input as { command: string }).command).toBe(cmd)
	})
})

describe('runTool — the sentinel produces a DIRECTIVE error, never a misleading schema dump', () => {
	it('names the malformation, echoes the raw payload, lists the expected keys, does not execute', async () => {
		const ctx: ToolContext = { cwd: tmpdir(), abortSignal: new AbortController().signal }
		const result = await executeTool(
			{ id: 't1', name: 'Read', input: { [RAW_ARGS_KEY]: '{"file_path" oops "a.ts"}' } },
			ctx,
		)
		expect(result.type).toBe('tool_result')
		expect((result as { isError?: boolean }).isError).toBe(true)
		const content = (result as { content: string }).content
		expect(content).toContain('MALFORMED')
		expect(content).toContain('{"file_path" oops "a.ts"}') // the model sees what it actually sent
		expect(content).toContain('file_path') // and the keys a correct call needs
		expect(content).not.toContain('missing') // NOT the old lie
	})
})

describe('the /v1 wire path repairs almost-JSON args end-to-end', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('trailing-comma args from the stream arrive as parsed input on the tool_use event', async () => {
		const sse = [
			`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path": "src/a.ts",}' } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
			'data: [DONE]',
		].join('\n\n')
		vi.stubGlobal('fetch', vi.fn(async () => new Response(`${sse}\n\n`, { status: 200 })))
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		const events: unknown[] = []
		for await (const ev of p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })) events.push(ev)
		const tu = events.find((e) => (e as { type: string }).type === 'tool_use') as { input: unknown }
		expect(tu).toBeDefined()
		expect(tu.input).toEqual({ file_path: 'src/a.ts' })
	})
})
