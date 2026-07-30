// chatStore.ts — chat persistence for the extension (resume a previous chat, chatStore-lite).
//
// Layout mirrors the server's chatStore, minus the event-replay log: `.cascade/chats/index.json` holds
// metadata (newest first); `.cascade/chats/<id>.json` holds the core Message[] history. Restore renders
// via historyToItems below — a faithful flattening of Message[] into the webview's Item shapes, so a
// reloaded transcript shows the same bubbles/tool cards/diffs the live session did.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@cascade/core'

export interface ChatMeta {
	id: string
	title: string
	updatedAt: string
}

/** The webview transcript item shapes (mirrors ui/App.tsx `Item` — kept in sync by the restore test). */
export type RestoredItem =
	| { kind: 'user'; text: string; images?: string[] }
	| { kind: 'assistant'; text: string; thinking?: string }
	| { kind: 'tool'; id: string; name: string; summary: string; status: 'ok' | 'error'; preview?: string; display?: unknown }

export class ChatStore {
	private readonly dir: string
	constructor(cwd: string) {
		this.dir = join(cwd, '.cascade', 'chats')
	}

	list(): ChatMeta[] {
		try {
			return JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as ChatMeta[]
		} catch {
			return []
		}
	}

	load(id: string): Message[] {
		try {
			return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as Message[]
		} catch {
			return []
		}
	}

	/** Persist a chat: history file + index entry (moved to front, title from the first user text). */
	save(id: string, messages: Message[]): void {
		if (messages.length === 0) return // never persist an empty chat (mirrors the server's abandoned-chat rule)
		mkdirSync(this.dir, { recursive: true })
		// Write-then-rename so a crash mid-write never corrupts the previous good file.
		const tmp = join(this.dir, `${id}.json.tmp`)
		writeFileSync(tmp, JSON.stringify(messages))
		renameSync(tmp, join(this.dir, `${id}.json`))
		const rest = this.list().filter((c) => c.id !== id)
		const meta: ChatMeta = { id, title: titleOf(messages), updatedAt: new Date().toISOString() }
		writeFileSync(join(this.dir, 'index.json'), JSON.stringify([meta, ...rest], null, 1))
	}

	delete(id: string): void {
		try {
			rmSync(join(this.dir, `${id}.json`), { force: true })
			writeFileSync(join(this.dir, 'index.json'), JSON.stringify(this.list().filter((c) => c.id !== id), null, 1))
		} catch {
			/* best-effort */
		}
	}
}

export function newChatId(): string {
	return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function titleOf(messages: Message[]): string {
	for (const m of messages) {
		if (m.role !== 'user') continue
		const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ')
		const clean = text.replace(/\s+/g, ' ').trim()
		if (clean && !clean.startsWith('<')) return clean.slice(0, 60)
	}
	return '(untitled)'
}

/** Flatten core Message[] history into renderable transcript items. Tool cards are rebuilt by pairing each
 *  assistant tool_use with its tool_result (preview capped; the display hint — diffs, todos — survives). */
export function historyToItems(messages: Message[]): RestoredItem[] {
	const items: RestoredItem[] = []
	const toolByUseId = new Map<string, Extract<RestoredItem, { kind: 'tool' }>>()
	for (const m of messages) {
		if (m.role === 'user') {
			if (typeof m.content === 'string') {
				items.push({ kind: 'user', text: m.content })
				continue
			}
			let text = ''
			const images: string[] = []
			for (const b of m.content) {
				if (b.type === 'text') text += b.text
				else if (b.type === 'image') images.push(b.url)
				else if (b.type === 'tool_result') {
					const t = toolByUseId.get(b.tool_use_id)
					if (t) {
						t.status = b.isError ? 'error' : 'ok'
						t.preview = (b.content || '').slice(0, 600)
						if (b.display) t.display = b.display
					}
				}
			}
			if (text.trim() || images.length) items.push({ kind: 'user', text, images: images.length ? images : undefined })
		} else {
			// Preserve BLOCK order: prose accumulated so far flushes before each tool card, exactly as the
			// blocks were produced.
			let text = ''
			let thinking = ''
			const flush = () => {
				if (text.trim() || thinking.trim()) items.push({ kind: 'assistant', text, thinking: thinking.trim() ? thinking : undefined })
				text = ''
				thinking = ''
			}
			for (const b of m.content) {
				if (b.type === 'text') text += b.text
				else if (b.type === 'thinking') thinking += b.thinking
				else if (b.type === 'tool_use') {
					flush()
					const input = (b.input ?? {}) as Record<string, unknown>
					const hint = [input.file_path, input.path, input.command, input.pattern, input.name].find((v) => typeof v === 'string') as string | undefined
					const tool: Extract<RestoredItem, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: b.name, summary: hint ? String(hint).slice(0, 80) : '', status: 'ok' }
					toolByUseId.set(b.id, tool)
					items.push(tool)
				}
			}
			flush()
		}
	}
	return items
}
