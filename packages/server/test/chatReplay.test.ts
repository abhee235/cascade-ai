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

// ADR-068 — prune vs a turn that is STILL RUNNING. Measured: opening a project mid-build pruned the very chat
// that was building (it looks "empty": save() runs only when the turn ENDS, so it still has no persisted
// messages and no derived title), then minted a fresh chat in its place — orphaning a 478 KB event log and
// wiping the in-progress transcript on every visit. A replay log with content means the chat is alive.
describe('ChatStore prune vs a live turn', () => {
	const fresh = () => {
		const d = mkdtempSync(join(tmpdir(), 'chatlive-'))
		afterAll(() => rmSync(d, { recursive: true, force: true }))
		return d
	}

	it('keeps an untitled, unsaved chat that has a replay log (its turn is mid-flight)', () => {
		const d = fresh()
		const store = new ChatStore()
		const live = store.create(d)
		store.appendEvent(d, live.id, { user: 'Build "StyleHub", a full-stack e-commerce app' }) // turn started; save() has NOT run
		const chats = store.list(d) // ← what the project-open handler calls
		expect(chats[0].id).toBe(live.id) // survives, and no empty chat is minted in front of it
		expect(store.events(d, live.id)).toHaveLength(1) // transcript intact
	})

	it('still prunes a genuinely abandoned chat (untitled, no messages, no events)', () => {
		const d = fresh()
		const store = new ChatStore()
		const abandoned = store.create(d)
		const chats = store.list(d)
		expect(chats).toHaveLength(1)
		expect(chats[0].id).not.toBe(abandoned.id) // dropped and replaced — the old behaviour, still correct
	})
})
