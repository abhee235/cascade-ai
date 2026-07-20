// ADR-060 — tool-result images reach the MODEL: a tool that returns `images` (Browser screenshot) gets
// them lifted onto the tool_results user message as image blocks, which the provider wires as vision input.

import { describe, expect, it } from 'vitest'
import { runAgentLoop } from '../src/agent/agentLoop'
import { registryOf } from '../src/tools/toolRegistry'
import type { Message } from '../src/protocol'
import type { Tool } from '../src/tools/Tool'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import { z } from 'zod'

const DATA_URI = 'data:image/jpeg;base64,ZmFrZQ=='

const CameraTool: Tool = {
	name: 'Camera',
	description: 'take a picture',
	inputSchema: z.object({}),
	isReadOnly: () => true,
	isConcurrencySafe: () => true,
	async call() {
		return { content: 'Screenshot attached.', images: [DATA_URI] }
	},
}

describe('tool-result images (ADR-060)', () => {
	it('a tool image becomes an image block on the results message — the next request carries it', async () => {
		const provider = createFakeProvider([
			[toolUse('c1', 'Camera', {}), done('tool_use')],
			[textDelta('I see it'), done('end_turn')],
		])
		const messages: Message[] = [{ role: 'user', content: 'look at the app' }]
		for await (const _ of runAgentLoop(messages, {
			provider,
			model: 'fake',
			cwd: process.cwd(),
			signal: new AbortController().signal,
			registry: registryOf(() => [CameraTool]),
			verifyGate: false,
		})) {
			/* drain */
		}
		const results = messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
		expect(results).toBeTruthy()
		const blocks = results!.content as { type: string; url?: string }[]
		expect(blocks.some((b) => b.type === 'image' && b.url === DATA_URI)).toBe(true) // vision payload delivered
		expect(JSON.stringify(provider.calls[1]!.messages)).toContain(DATA_URI) // and the model was sent it
	})
})
