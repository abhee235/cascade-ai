// Chat persistence (resume a previous chat) + historyToItems restore fidelity.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@cascade/core'
import { ChatStore, historyToItems, newChatId } from '../src/chatStore'

const dirs: string[] = []
function freshStore(): ChatStore {
	const d = mkdtempSync(join(tmpdir(), 'cascade-chats-'))
	dirs.push(d)
	return new ChatStore(d)
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('ChatStore', () => {
	it('save → list (newest first, titled from the first user text) → load roundtrip', () => {
		const store = freshStore()
		const a = newChatId()
		const b = newChatId()
		store.save(a, [{ role: 'user', content: 'Build a todo app with dark mode' }])
		store.save(b, [{ role: 'user', content: 'Fix the login bug' }])
		const list = store.list()
		expect(list.map((c) => c.id)).toEqual([b, a]) // most recent first
		expect(list[1]!.title).toBe('Build a todo app with dark mode')
		expect(store.load(a)).toEqual([{ role: 'user', content: 'Build a todo app with dark mode' }])
	})

	it('never persists an empty chat; delete removes file + index entry', () => {
		const store = freshStore()
		const id = newChatId()
		store.save(id, [])
		expect(store.list()).toEqual([])
		store.save(id, [{ role: 'user', content: 'hi' }])
		expect(store.list()).toHaveLength(1)
		store.delete(id)
		expect(store.list()).toEqual([])
		expect(store.load(id)).toEqual([])
	})
})

describe('historyToItems — restore renders what the live session showed', () => {
	it('pairs tool_use with its tool_result (status, preview, display) and keeps order', () => {
		const history: Message[] = [
			{ role: 'user', content: 'add a button' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'plan it' },
					{ type: 'text', text: 'Editing now.' },
					{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/App.tsx' } },
				],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', display: { kind: 'fileEdit', path: 'src/App.tsx', op: 'edit', diff: '+x' } }],
			},
			{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
		]
		const items = historyToItems(history)
		expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
		const tool = items[2] as Extract<(typeof items)[number], { kind: 'tool' }>
		expect(tool.name).toBe('Edit')
		expect(tool.summary).toBe('src/App.tsx')
		expect(tool.status).toBe('ok')
		expect((tool.display as { kind: string }).kind).toBe('fileEdit')
		const assistant = items[1] as Extract<(typeof items)[number], { kind: 'assistant' }>
		expect(assistant.thinking).toBe('plan it')
	})

	it('an errored tool_result marks the card; tool-result-only user messages render no user bubble', () => {
		const history: Message[] = [
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'FAIL', isError: true }] },
		]
		const items = historyToItems(history)
		expect(items).toHaveLength(1)
		const tool = items[0] as Extract<(typeof items)[number], { kind: 'tool' }>
		expect(tool.status).toBe('error')
		expect(tool.preview).toBe('FAIL')
	})

	it('user image blocks survive restore', () => {
		const history: Message[] = [
			{ role: 'user', content: [{ type: 'text', text: 'match this design' }, { type: 'image', url: 'data:image/png;base64,X' }] },
		]
		const items = historyToItems(history)
		expect(items[0]).toEqual({ kind: 'user', text: 'match this design', images: ['data:image/png;base64,X'] })
	})
})
