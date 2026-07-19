// M11+ — the chat REPLAY LOG. Measured gap: a reloaded chat rendered from flattened rows (thinking dropped,
// tool status/diffs lost, <system-reminder> walls leaking as user bubbles) instead of what the live session
// showed. The store now appends the relayed ActivityEvents per chat; reopening re-dispatches them through
// the client's live reducer — reload = live by construction.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ChatStore } from '../src/chatStore'

const dir = mkdtempSync(join(tmpdir(), 'chatreplay-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('ChatStore replay log', () => {
	it('appends entries and reads them back in order (user rows + events)', () => {
		const store = new ChatStore()
		const meta = store.create(dir)
		store.appendEvent(dir, meta.id, { user: 'Build "Simmer"' })
		store.appendEvent(dir, meta.id, { event: { type: 'toolStart', id: 't1', name: 'Write', summary: 'Writing src/types.ts' } })
		store.appendEvent(dir, meta.id, { event: { type: 'toolResult', id: 't1', ok: true, preview: '', display: { kind: 'fileEdit', path: 'src/types.ts', op: 'create', diff: '+x' } } })
		const entries = store.events(dir, meta.id)
		expect(entries).toHaveLength(3)
		expect(entries[0]).toEqual({ user: 'Build "Simmer"' })
		expect((entries[2] as { event: { display: { kind: string } } }).event.display.kind).toBe('fileEdit') // display hints survive — the diff card renders on reload
	})

	it('a pre-log chat returns [] (caller falls back to flattened rows)', () => {
		const store = new ChatStore()
		const meta = store.create(dir)
		expect(store.events(dir, meta.id)).toEqual([])
	})

	it('a torn tail line (crash mid-append) is skipped, not fatal', () => {
		const store = new ChatStore()
		const meta = store.create(dir)
		store.appendEvent(dir, meta.id, { user: 'hello' })
		// simulate a crash mid-write: append a partial JSON line by hand
		const { appendFileSync } = require('node:fs') as typeof import('node:fs')
		appendFileSync(join(dir, '.cascade', `chat-${meta.id}.events.jsonl`), '{"event":{"type":"tool')
		expect(store.events(dir, meta.id)).toEqual([{ user: 'hello' }])
	})

	it('delete removes the replay log with the chat', () => {
		const store = new ChatStore()
		const meta = store.create(dir)
		store.appendEvent(dir, meta.id, { user: 'x' })
		store.delete(dir, meta.id)
		expect(store.events(dir, meta.id)).toEqual([])
	})
})
