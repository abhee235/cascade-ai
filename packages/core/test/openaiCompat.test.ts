import { afterEach, describe, it, expect, vi } from 'vitest'
import { DEFAULT_MAX_OUTPUT_TOKENS, OpenAIChatProvider, toOpenAIMessages } from '../src/llm/providers/openaiChat'
import { OpenAIResponsesProvider, toResponsesInput } from '../src/llm/providers/openaiResponses'
import type { StreamEvent } from '../src/llm/provider'
import type { Message } from '../src/protocol'

describe('toOpenAIMessages (the bridge)', () => {
  it('prepends the system prompt', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }], 'SYS')
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('assistant tool_use → tool_calls with JSON-stringified args', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a' } }] },
    ]
    const out: any = toOpenAIMessages(msgs)
    expect(out[0].role).toBe('assistant')
    expect(out[0].content).toBe('ok')
    expect(out[0].tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'Read' } })
    expect(JSON.parse(out[0].tool_calls[0].function.arguments)).toEqual({ file_path: 'a' })
  })

  it('user tool_result → role:tool message keyed by tool_use_id', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'RESULT' }] }]
    const out = toOpenAIMessages(msgs)
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'RESULT' })
  })

  it('singleToolCall collapses a parallel-call turn to one call AND drops the orphaned tool_result', () => {
    // A recorded turn with two parallel tool calls + both results (the shape that 500s NIM llama-3.1-8b).
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Write', input: { p: 'a' } }, { type: 'tool_use', id: 'c2', name: 'Read', input: { p: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'wrote' }, { type: 'tool_result', tool_use_id: 'c2', content: 'read' }] },
    ]
    const out: any = toOpenAIMessages(msgs, undefined, { singleToolCall: true })
    expect(out[0].tool_calls).toHaveLength(1) // only the first call survives
    expect(out[0].tool_calls[0].id).toBe('c1')
    // exactly one role:tool message — c2's result is dropped so it isn't an orphan tool_call_id
    const toolMsgs = out.filter((m: any) => m.role === 'tool')
    expect(toolMsgs).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'wrote' }])
  })

  it('singleToolCall is a no-op for single-call turns (does not alter normal history)', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'r' }] },
    ]
    expect(toOpenAIMessages(msgs, undefined, { singleToolCall: true })).toEqual(toOpenAIMessages(msgs))
  })
})

// ── Hosted-provider wire format (multi-provider) ────────────────────────────────────────────────────────
// Asserted through a stubbed fetch: what Cascade PUTS ON THE WIRE, per provider id.

const sentBody = (fetchMock: ReturnType<typeof vi.fn>): any => JSON.parse((fetchMock.mock.calls[0] as any)[1].body)

afterEach(() => vi.unstubAllGlobals())

describe('hosted wire format', () => {
  it('openai gets max_completion_tokens (current models 400 on max_tokens); others keep max_tokens', async () => {
    for (const [id, field, absent] of [
      ['openai', 'max_completion_tokens', 'max_tokens'],
      ['nvidia', 'max_tokens', 'max_completion_tokens'],
    ] as const) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
      vi.stubGlobal('fetch', fetchMock)
      const p = new OpenAIChatProvider({ id, baseUrl: 'http://x' })
      await p.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm', maxOutputTokens: 512 })
      expect(sentBody(fetchMock)[field], id).toBe(512)
      expect(sentBody(fetchMock)[absent], id).toBeUndefined()
    }
  })

  it('ALWAYS sends an output cap — an unpinned maxOutputTokens falls back to the default, never omitted', async () => {
    // Measured 2026-07-25: a rented Ollama `/v1` endpoint added without maxOutputTokens got NO max_tokens, so
    // the BACKEND's own default applied and returned finish_reason:"length" after as few as 38 output tokens —
    // the loop's max-tokens gate fired 6× and the build stalled with empty turns. Never omit it.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' })
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }) // no maxOutputTokens
    expect(sentBody(fetchMock).max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('streams reasoning_content deltas (NVIDIA/DeepSeek convention) as thinking', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"THINK"}}]}',
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse)))
    const p = new OpenAIChatProvider({ id: 'nvidia', baseUrl: 'http://x' })
    const events: StreamEvent[] = []
    for await (const e of p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })) events.push(e)
    expect(events).toContainEqual({ type: 'thinking_delta', thinking: 'THINK' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'hello' })
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
  })

  it('retries with reasoning_effort:none when a tool request hits the reasoning+tools 400', async () => {
    // A Response body reads only once — mint a fresh one per call.
    const err400 = () => new Response(
      JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } }),
      { status: 400 },
    )
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }))
    const fetchMock = vi.fn().mockResolvedValueOnce(err400()).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIChatProvider({ id: 'openai', baseUrl: 'http://x' })
    const tools = [{ name: 'Read', description: 'read', parameters: { type: 'object' } }]
    const out = await p.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5.6-luna', tools })
    expect(out.text).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // first attempt has no reasoning_effort; the retry adds 'none'
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).reasoning_effort).toBeUndefined()
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body).reasoning_effort).toBe('none')
    // a subsequent call for the SAME model skips the doomed first attempt (sends 'none' up front)
    fetchMock.mockClear().mockResolvedValueOnce(ok())
    await p.complete({ messages: [{ role: 'user', content: 'again' }], model: 'gpt-5.6-luna', tools })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).reasoning_effort).toBe('none')
  })

  it('learns forceSingleTool on the "single tool-calls" 500 and retries with collapsed history', async () => {
    const err500 = () => new Response(JSON.stringify({ error: { message: 'Failed to apply prompt template: invalid operation: This model only supports single tool-calls at once!' } }), { status: 500 })
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }))
    const fetchMock = vi.fn().mockResolvedValueOnce(err500()).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIChatProvider({ id: 'nvidia', baseUrl: 'http://x' })
    // history carrying a parallel-call turn (the poison shape)
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Write', input: {} }, { type: 'tool_use', id: 'c2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'w' }, { type: 'tool_result', tool_use_id: 'c2', content: 'r' }] },
    ]
    const tools = [{ name: 'Read', description: 'r', parameters: {} }]
    const out = await p.complete({ messages, model: 'meta/llama-3.1-8b-instruct', tools })
    expect(out.text).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // first attempt sends BOTH tool_calls; the retry collapses to one and adds parallel_tool_calls:false
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).messages[0].tool_calls).toHaveLength(2)
    const retryBody = JSON.parse((fetchMock.mock.calls[1] as any)[1].body)
    expect(retryBody.messages[0].tool_calls).toHaveLength(1)
    expect(retryBody.parallel_tool_calls).toBe(false)
  })

  it('does NOT force reasoning_effort:none for models that accept tools (no spurious retry)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIChatProvider({ id: 'openai', baseUrl: 'http://x' })
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5-mini', tools: [{ name: 'Read', description: 'r', parameters: {} }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).reasoning_effort).toBeUndefined()
  })

  it('hosted chat providers expose NO detectModelLimits (the /api/show probe is Ollama-only)', () => {
    // Post-split contract: the optional method is absent on hosted adapters, so session.ts's
    // `!opts.provider.detectModelLimits` guard skips it and falls back to the model→window map.
    const p = new OpenAIChatProvider({ id: 'openai', baseUrl: 'https://api.openai.com' })
    expect((p as { detectModelLimits?: unknown }).detectModelLimits).toBeUndefined()
  })
})

// ── OpenAI Responses API (/v1/responses) — the reasoning+tools path ──────────────────────────────────────

describe('toResponsesInput (the Responses bridge)', () => {
	it("array-content message items carry an explicit type: 'message' (llama-server rejects the inferred form)", () => {
		// Measured (llama-server b10488, 2026-08-19): OpenAI infers the item type from `role`, but llama.cpp's
		// /v1/responses parser only infers it for STRING content — {role:'assistant', content:[…]} without
		// type:'message' is HTTP 400 "Cannot determine type of 'item'". The first assistant TEXT message a
		// session replays is the COMPACTION SUMMARY, so every builder run died at its first compaction.
		const { input } = toResponsesInput([
			{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:image/png;base64,x' }] },
			{ role: 'assistant', content: 'summary of the run so far' },
			{ role: 'user', content: 'continue' },
		])
		for (const item of input) {
			if ('role' in item && Array.isArray((item as { content?: unknown }).content)) {
				expect((item as { type?: string }).type, JSON.stringify(item).slice(0, 80)).toBe('message')
			}
		}
		// …and the assistant text itself is one of those array-content items.
		expect(input.some((i) => (i as { type?: string }).type === 'message' && (i as { role?: string }).role === 'assistant')).toBe(true)
	})

  it('system → instructions; a plain user turn → a string-content input item', () => {
    const { instructions, input } = toResponsesInput([{ role: 'user', content: 'hi' }], 'SYS')
    expect(instructions).toBe('SYS')
    expect(input).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('assistant tool_use → function_call item (call_id = our id, arguments JSON-stringified)', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a' } }] },
    ]
    const { input } = toResponsesInput(msgs)
    expect(input[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] })
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'c1', name: 'Read', arguments: JSON.stringify({ file_path: 'a' }) })
  })

  it('user tool_result → function_call_output keyed by call_id', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'RESULT' }] },
    ]
    expect(toResponsesInput(msgs).input[1]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'RESULT' })
  })

  // Measured: one orphaned output → HTTP 400 "No tool call found for function call output with call_id …",
  // and since it lives in the SAVED history it replays every turn — the chat never runs again. Histories lose
  // their head legitimately (compaction drops old turns; an interrupted turn is saved mid-pair).
  it('drops a tool_result whose function_call is no longer in the history (compaction / interrupted turn)', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'RESULT' }] }]
    expect(toResponsesInput(msgs).input).toEqual([])
  })

  it('keeps the user text when only the orphaned result is dropped', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'R' }, { type: 'text', text: 'carry on' }] }]
    expect(toResponsesInput(msgs).input).toEqual([{ role: 'user', content: 'carry on' }])
  })

  it('a user image turn → input_text + input_image parts', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:image/png;base64,AAA' }] }]
    expect(toResponsesInput(msgs).input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] })
  })
})

describe('streamResponses (OpenAI routes here)', () => {
  // Real /v1/responses event shapes (verified live 2026-07-20). One text delta, one reasoning-summary delta,
  // a whole function_call on output_item.done, and usage on response.completed.
  const sse = [
    'data: {"type":"response.reasoning_summary_text.delta","delta":"pondering"}',
    'data: {"type":"response.output_text.delta","delta":"hello"}',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"Write","arguments":"{\\"path\\":\\"a.txt\\"}"}}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":42,"output_tokens":99}}}',
    'data: [DONE]',
    '',
  ].join('\n\n')

  it('emits thinking, text, a tool_use, and done with usage — hitting the responses endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(sse))
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIResponsesProvider({ id: 'openai', baseUrl: 'https://api.openai.com' })
    const events: StreamEvent[] = []
    for await (const e of p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5.6-luna', tools: [{ name: 'Write', description: 'w', parameters: {} }] })) events.push(e)
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://api.openai.com/v1/responses')
    expect(events).toContainEqual({ type: 'thinking_delta', thinking: 'pondering' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'hello' })
    expect(events).toContainEqual({ type: 'tool_use', id: 'call_9', name: 'Write', input: { path: 'a.txt' } })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use', usage: { inputTokens: 42, outputTokens: 99 } })
  })

  it('a non-openai provider does NOT hit the responses endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetchMock)
    const p = new OpenAIChatProvider({ id: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com' })
    for await (const _ of p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })) { /* drain */ }
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
  })
})

// ── TASK-thinking-control: the reasoning-effort knob on each wire ───────────────────────────────────────
// Levels map per adapter (chat reasoning_effort/chat_template_kwargs, ollama think, responses reasoning.effort),
// and backends that reject a field lose the FIELD via the learned-quirk degrade — never the turn.

describe('thinking control (wire mapping + degrade)', () => {
	const drain = async (it: AsyncIterable<StreamEvent>) => {
		const evs: StreamEvent[] = []
		for await (const e of it) evs.push(e)
		return evs
	}
	const chatOk = () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

	it('chat, self-hosted id: level → reasoning_effort AND chat_template_kwargs; off → none + enable_thinking:false', async () => {
		for (const [thinking, effort, kwargs] of [
			['low', 'low', { reasoning_effort: 'low' }],
			['off', 'none', { enable_thinking: false }],
		] as const) {
			const fetchMock = vi.fn(async () => chatOk())
			vi.stubGlobal('fetch', fetchMock)
			const p = new OpenAIChatProvider({ id: 'hetzner', baseUrl: 'http://x' })
			await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking }))
			const body = sentBody(fetchMock)
			expect(body.reasoning_effort).toBe(effort)
			expect(body.chat_template_kwargs).toEqual(kwargs)
		}
	})

	it('chat, hosted id: reasoning_effort only — no chat_template_kwargs (strict gateways 400 unknown params)', async () => {
		const fetchMock = vi.fn(async () => chatOk())
		vi.stubGlobal('fetch', fetchMock)
		const p = new OpenAIChatProvider({ id: 'openai', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'high' }))
		const body = sentBody(fetchMock)
		expect(body.reasoning_effort).toBe('high')
		expect(body.chat_template_kwargs).toBeUndefined()
	})

	it('chat: omitted knob puts NOTHING on the wire (model default preserved)', async () => {
		const fetchMock = vi.fn(async () => chatOk())
		vi.stubGlobal('fetch', fetchMock)
		const p = new OpenAIChatProvider({ id: 'hetzner', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }))
		const body = sentBody(fetchMock)
		expect(body.reasoning_effort).toBeUndefined()
		expect(body.chat_template_kwargs).toBeUndefined()
	})

	it('chat degrade chain: 400 on kwargs drops kwargs; then 400 on reasoning_effort drops the knob — remembered', async () => {
		const responses = [
			new Response('{"error":"Extra inputs are not permitted: chat_template_kwargs"}', { status: 400 }),
			new Response('{"error":"Unrecognized request argument: reasoning_effort"}', { status: 400 }),
			chatOk(),
		]
		const fetchMock = vi.fn(async () => responses.shift()!)
		vi.stubGlobal('fetch', fetchMock)
		const p = new OpenAIChatProvider({ id: 'strict', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'medium' }))
		expect(fetchMock).toHaveBeenCalledTimes(3)
		const second = JSON.parse((fetchMock.mock.calls[1] as any)[1].body)
		expect(second.chat_template_kwargs).toBeUndefined()
		expect(second.reasoning_effort).toBe('medium')
		const third = JSON.parse((fetchMock.mock.calls[2] as any)[1].body)
		expect(third.reasoning_effort).toBeUndefined()
		// remembered: the next call skips the doomed attempts entirely
		const fetchMock2 = vi.fn(async () => chatOk())
		vi.stubGlobal('fetch', fetchMock2)
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'medium' }))
		expect(fetchMock2).toHaveBeenCalledTimes(1)
		expect(sentBody(fetchMock2).reasoning_effort).toBeUndefined()
	})

	it('responses: level → reasoning.effort; off → minimal (reasoning models have no true off)', async () => {
		for (const [thinking, effort] of [
			['medium', 'medium'],
			['off', 'minimal'],
		] as const) {
			const fetchMock = vi.fn(async () => new Response('data: [DONE]\n\n'))
			vi.stubGlobal('fetch', fetchMock)
			const p = new OpenAIResponsesProvider({ id: 'openai', baseUrl: 'http://x' })
			await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking }))
			expect(sentBody(fetchMock).reasoning).toEqual({ summary: 'auto', effort })
		}
	})

	it('alive(): /v1/models 200 → true, network failure → false (the queued-backend liveness probe)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
		const p = new OpenAIChatProvider({ id: 'hetzner', baseUrl: 'http://x' })
		await expect(p.alive()).resolves.toBe(true)
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
		await expect(p.alive()).resolves.toBe(false)
	})
})

describe('thinking control — ollama native think', () => {
	const ndOk = () => new Response('{"done":true,"done_reason":"stop"}\n')
	const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0): any => JSON.parse((fetchMock.mock.calls[i] as any)[1].body)
	const drain = async (it: AsyncIterable<StreamEvent>) => {
		for await (const _ of it) {
			/* drain */
		}
	}

	it('level rides as think:"low"; off as think:false; omitted knob sends no think field', async () => {
		const { OllamaProvider } = await import('../src/llm/providers/ollama')
		for (const [thinking, expected] of [
			['low', 'low'],
			['off', false],
			[undefined, undefined],
		] as const) {
			const fetchMock = vi.fn(async () => ndOk())
			vi.stubGlobal('fetch', fetchMock)
			const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
			await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking }))
			expect(bodyOf(fetchMock).think).toEqual(expected)
		}
	})

	it('degrades level→boolean on the think-level 400, and remembers', async () => {
		const { OllamaProvider } = await import('../src/llm/providers/ollama')
		const responses = [new Response('{"error":"model does not support think level \\"medium\\""}', { status: 400 }), ndOk()]
		const fetchMock = vi.fn(async () => responses.shift()!)
		vi.stubGlobal('fetch', fetchMock)
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'medium' }))
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(bodyOf(fetchMock, 1).think).toBe(true) // boolean fallback
		// remembered: next stream sends the boolean immediately
		const fetchMock2 = vi.fn(async () => ndOk())
		vi.stubGlobal('fetch', fetchMock2)
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'medium' }))
		expect(bodyOf(fetchMock2).think).toBe(true)
	})

	it('drops think entirely for models that do not support thinking at all', async () => {
		const { OllamaProvider } = await import('../src/llm/providers/ollama')
		const responses = [new Response('{"error":"registry.ollama.ai/library/m does not support thinking"}', { status: 400 }), ndOk()]
		const fetchMock = vi.fn(async () => responses.shift()!)
		vi.stubGlobal('fetch', fetchMock)
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', thinking: 'high' }))
		expect(bodyOf(fetchMock, 1).think).toBeUndefined()
	})
})
