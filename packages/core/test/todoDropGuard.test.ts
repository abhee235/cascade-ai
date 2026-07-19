// ADR-058 — the TodoWrite DROPPED-ITEM guard. TodoWrite is full-list replacement; measured
// (Simmer, killed session): two rewrites silently dropped still-pending items ("Create DetailView", "Delete
// demo/", "Build and verify") and the session terminated early with the todo gate blind to them. The tool
// now diffs the incoming list against the stored one and NAMES vanished unfinished items in its result.

import { describe, expect, it } from 'vitest'
import { TodoWriteTool } from '../src/tools/builtins/TodoWrite'
import { TodoStore } from '../src/tools/todoStore'
import type { ToolContext } from '../src/tools/Tool'

const ctxWith = (store: TodoStore): ToolContext =>
	({ cwd: '.', abortSignal: new AbortController().signal, todoStore: store, depth: 0 }) as unknown as ToolContext

const item = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: content })

describe('TodoWrite dropped-item guard', () => {
	it('names unfinished items that a rewrite silently removed — and still stores the new list', async () => {
		const store = new TodoStore()
		store.set(0, [item('Create AddForm', 'in_progress'), item('Create DetailView recipe reader', 'pending'), item('Build and verify', 'pending')])
		const res = await TodoWriteTool.call({ todos: [item('Create AddForm', 'completed'), item('Polish styling', 'pending')] }, ctxWith(store))
		expect(res.content).toContain('REMOVED 2 unfinished task(s)')
		expect(res.content).toContain('"Create DetailView recipe reader"')
		expect(res.content).toContain('"Build and verify"')
		expect(store.get(0).map((t) => t.content)).toEqual(['Create AddForm', 'Polish styling']) // authoritative = what was sent; the guard warns, never rewrites
	})

	it('dropping a COMPLETED item is normal list hygiene — no warning', async () => {
		const store = new TodoStore()
		store.set(0, [item('Set up project', 'completed'), item('Build views', 'in_progress')])
		const res = await TodoWriteTool.call({ todos: [item('Build views', 'in_progress')] }, ctxWith(store))
		expect(res.content).not.toContain('REMOVED')
	})

	it('a REPHRASED item (substring either way) is not a false positive', async () => {
		const store = new TodoStore()
		store.set(0, [item('Create AddForm', 'pending')])
		const res = await TodoWriteTool.call({ todos: [item('Create AddForm component with validation', 'in_progress')] }, ctxWith(store))
		expect(res.content).not.toContain('REMOVED')
	})

	it('first call (empty store) never warns', async () => {
		const store = new TodoStore()
		const res = await TodoWriteTool.call({ todos: [item('Plan the app', 'in_progress')] }, ctxWith(store))
		expect(res.content).not.toContain('REMOVED')
	})

	it('activeForm is OPTIONAL and defaults to the task text (5 measured schema rejections per run)', async () => {
		const store = new TodoStore()
		const res = await TodoWriteTool.call(
			{ todos: [{ content: 'Fix data.ts', status: 'in_progress' }, { content: 'Wire App.tsx', status: 'pending' }] },
			ctxWith(store),
		)
		expect(res.content).toContain('Todos updated')
		expect(store.get(0).map((t) => t.activeForm)).toEqual(['Fix data.ts', 'Wire App.tsx']) // defaulted, stored complete
	})
})
