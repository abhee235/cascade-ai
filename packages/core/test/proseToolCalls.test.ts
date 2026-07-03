import { describe, expect, it } from 'vitest'
import { extractProseToolCalls } from '../src/llm/proseToolCalls'

const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite']

// The ACTUAL llama3.2:3b output that produced the 0/10 baseline (trace: baseline-llama32-3b,
// edit-rename-function-t1) — five calls in one ```json fence, including a hallucinated "Rename" tool.
const REAL_3B_OUTPUT = `\`\`\`json
{
  "name": "Glob",
  "parameters": {
    "pattern": "src/**/*.js",
    "path": "src"
  }
}
{
  "name": "Read",
  "parameters": {
    "file_path": "src/user.js"
  }
}
{
  "name": "Rename",
  "parameters": {
    "old_name": "getUserData",
    "new_name": "fetchUserProfile"
  }
}
{
  "name": "Edit",
  "parameters": {
    "file_path": "src/user.js",
    "old_string": "",
    "new_string": ""
  }
}
\`\`\``

describe('extractProseToolCalls — the real 3b payload', () => {
	it('recovers the advertised-tool calls in order and drops the hallucinated one', () => {
		const calls = extractProseToolCalls(REAL_3B_OUTPUT, TOOLS)
		expect(calls.map((c) => c.name)).toEqual(['Glob', 'Read', 'Edit']) // "Rename" filtered out
		expect(calls[0]!.input).toEqual({ pattern: 'src/**/*.js', path: 'src' })
		expect(calls[1]!.input).toEqual({ file_path: 'src/user.js' })
	})
})

describe('extractProseToolCalls — format variants', () => {
	it('<tool_call> tags (qwen convention)', () => {
		const calls = extractProseToolCalls('<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"}}</tool_call>', TOOLS)
		expect(calls).toEqual([{ name: 'Read', input: { file_path: 'a.ts' } }])
	})

	it('bare JSON object, `tool` key, case-insensitive name match', () => {
		const calls = extractProseToolCalls('I will use {"tool":"read","input":{"file_path":"a.ts"}} now.', TOOLS)
		expect(calls).toEqual([{ name: 'Read', input: { file_path: 'a.ts' } }])
	})

	it('OpenAI-echo shape: nested function + arguments as a JSON string', () => {
		const calls = extractProseToolCalls('{"function":{"name":"Bash","arguments":"{\\"command\\":\\"node --test\\"}"}}', TOOLS)
		expect(calls).toEqual([{ name: 'Bash', input: { command: 'node --test' } }])
	})

	it('array form inside a fence', () => {
		const calls = extractProseToolCalls('```json\n[{"name":"Glob","parameters":{"pattern":"*"}},{"name":"Read","parameters":{"file_path":"x"}}]\n```', TOOLS)
		expect(calls.map((c) => c.name)).toEqual(['Glob', 'Read'])
	})

	it('unterminated fence (stream cut off) still parses complete objects', () => {
		const calls = extractProseToolCalls('```json\n{"name":"Read","parameters":{"file_path":"a.ts"}}\n{"name":"Wri', TOOLS)
		expect(calls.map((c) => c.name)).toEqual(['Read'])
	})
})

describe('extractProseToolCalls — safety (must NOT fire on these)', () => {
	it('plain prose answers', () => {
		expect(extractProseToolCalls('The bug is in paginate(): start should be (page-1)*perPage.', TOOLS)).toEqual([])
	})

	it('JSON that is not a tool call (a config object with a name field of the wrong kind)', () => {
		expect(extractProseToolCalls('{"name": 42, "parameters": {}}', TOOLS)).toEqual([])
		expect(extractProseToolCalls('{"version": "1.0", "scripts": {"test": "node --test"}}', TOOLS)).toEqual([])
	})

	it('tool-shaped JSON naming a tool that was NOT advertised', () => {
		expect(extractProseToolCalls('{"name":"DeleteEverything","parameters":{}}', TOOLS)).toEqual([])
	})

	it('code that discusses tool JSON inside strings (brace scanner is string-aware)', () => {
		const text = 'const s = "{ not a call }"; console.log("{\\"name\\": unbalanced")'
		expect(extractProseToolCalls(text, TOOLS)).toEqual([])
	})

	it('empty text / no advertised tools', () => {
		expect(extractProseToolCalls('', TOOLS)).toEqual([])
		expect(extractProseToolCalls('{"name":"Read","parameters":{}}', [])).toEqual([])
	})
})
