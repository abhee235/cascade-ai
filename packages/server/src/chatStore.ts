// chatStore.ts — multiple chats per project (M11), persisted under the project's `.cascade/` dir so they
// survive server restarts. An index (chats.json) holds the chat list + which is active; each chat's core
// conversation lives in chat-<id>.json. The wsServer swaps a session's history (getHistory/loadHistory) when
// switching chats, so each chat has its own agent context. Server-only; the web app sees only chat metadata.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Message } from '@cascade/core'
import type { ChatMeta, ChatReplayEntry } from '@cascade/app-protocol'

const cascadeDir = (projectDir: string) => join(projectDir, '.cascade')
const indexPath = (projectDir: string) => join(cascadeDir(projectDir), 'chats.json')
const chatPath = (projectDir: string, id: string) => join(cascadeDir(projectDir), `chat-${id}.json`)
/** The chat's REPLAY LOG — the ActivityEvents the client rendered live, appended as JSONL. On reopen these
 *  are re-dispatched through the same client reducer, so a reloaded transcript renders exactly as it was
 *  built (the flattened chat-<id>.json rows remain only as the pre-log legacy fallback). */
const eventsPath = (projectDir: string, id: string) => join(cascadeDir(projectDir), `chat-${id}.events.jsonl`)
const newId = () => randomBytes(4).toString('hex')

/** Soft cap on replayed entries — a marathon chat replays its most recent slice, not an unbounded file. */
const MAX_REPLAY_ENTRIES = 3000

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export class ChatStore {
  private readIndex(projectDir: string): ChatMeta[] {
    return readJson<ChatMeta[]>(indexPath(projectDir), [])
  }
  private writeIndex(projectDir: string, chats: ChatMeta[]): void {
    mkdirSync(cascadeDir(projectDir), { recursive: true })
    writeFileSync(indexPath(projectDir), JSON.stringify(chats, null, 2))
  }

  /** The project's chats (newest first), creating a first one if none exist. Prunes abandoned empties first
   *  (still-untitled chats with no messages — the "New chat someone clicked and walked away from" clutter),
   *  keeping `keepId` (the active chat may legitimately be empty right now). */
  list(projectDir: string, keepId?: string): ChatMeta[] {
    this.prune(projectDir, keepId)
    let chats = this.readIndex(projectDir)
    if (chats.length === 0) {
      const m = this.create(projectDir)
      chats = [m]
    }
    return chats
  }

  /** Read-only view of the chat list — never creates or prunes. For cross-project listings (the Chats page). */
  peek(projectDir: string): ChatMeta[] {
    return this.readIndex(projectDir)
  }

  /** Does this chat have a replay log with content? A chat whose turn is STILL RUNNING has events but no
   *  persisted messages and no title yet (save() only runs when the turn ends) — so message-emptiness alone
   *  would classify a live, actively-building chat as abandoned and delete it (measured: opening a project
   *  mid-build pruned the running chat and orphaned its 499-event log, wiping the in-progress transcript). */
  private hasEvents(projectDir: string, id: string): boolean {
    try {
      return statSync(eventsPath(projectDir, id)).size > 0
    } catch {
      return false
    }
  }

  /** Drop chats that are still untitled AND have no persisted messages AND no replay log (except `keepId`). */
  prune(projectDir: string, keepId?: string): void {
    const chats = this.readIndex(projectDir)
    const empty = chats.filter(
      (c) => c.id !== keepId && c.title === 'New chat' && this.messages(projectDir, c.id).length === 0 && !this.hasEvents(projectDir, c.id),
    )
    if (!empty.length) return
    this.writeIndex(projectDir, chats.filter((c) => !empty.includes(c)))
    for (const c of empty) if (existsSync(chatPath(projectDir, c.id))) rmSync(chatPath(projectDir, c.id))
  }

  create(projectDir: string): ChatMeta {
    const now = new Date().toISOString()
    const meta: ChatMeta = { id: newId(), title: 'New chat', createdAt: now, updatedAt: now }
    const chats = this.readIndex(projectDir)
    chats.unshift(meta)
    this.writeIndex(projectDir, chats)
    writeFileSync(chatPath(projectDir, meta.id), '[]')
    return meta
  }

  /** A chat's persisted conversation (empty if new/missing). */
  messages(projectDir: string, id: string): Message[] {
    return readJson<Message[]>(chatPath(projectDir, id), [])
  }

  /** Persist a chat's conversation; bump updatedAt and, if still untitled, derive a title from `firstUserText`. */
  save(projectDir: string, id: string, messages: Message[], firstUserText?: string): void {
    mkdirSync(cascadeDir(projectDir), { recursive: true })
    writeFileSync(chatPath(projectDir, id), JSON.stringify(messages))
    const chats = this.readIndex(projectDir)
    const meta = chats.find((c) => c.id === id)
    if (meta) {
      meta.updatedAt = new Date().toISOString()
      if (meta.title === 'New chat' && firstUserText) meta.title = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat'
      this.writeIndex(projectDir, chats)
    }
  }

  /** Append one replay entry (best-effort — persistence must never break a live turn). */
  appendEvent(projectDir: string, id: string, entry: ChatReplayEntry): void {
    try {
      mkdirSync(cascadeDir(projectDir), { recursive: true })
      appendFileSync(eventsPath(projectDir, id), `${JSON.stringify(entry)}\n`)
    } catch {
      /* a full disk or locked file loses replay fidelity, not the session */
    }
  }

  /** The chat's replay log (empty for pre-log chats → caller falls back to the flattened rows). */
  events(projectDir: string, id: string): ChatReplayEntry[] {
    try {
      const lines = readFileSync(eventsPath(projectDir, id), 'utf8').trim().split('\n')
      return lines.slice(-MAX_REPLAY_ENTRIES).flatMap((l) => {
        try {
          return [JSON.parse(l) as ChatReplayEntry]
        } catch {
          return [] // a torn tail line (crash mid-append) is skipped, not fatal
        }
      })
    } catch {
      return []
    }
  }

  rename(projectDir: string, id: string, title: string): void {
    const chats = this.readIndex(projectDir)
    const meta = chats.find((c) => c.id === id)
    if (meta) {
      meta.title = title.trim().slice(0, 80) || meta.title
      this.writeIndex(projectDir, chats)
    }
  }

  delete(projectDir: string, id: string): void {
    this.writeIndex(projectDir, this.readIndex(projectDir).filter((c) => c.id !== id))
    if (existsSync(chatPath(projectDir, id))) rmSync(chatPath(projectDir, id))
    if (existsSync(eventsPath(projectDir, id))) rmSync(eventsPath(projectDir, id))
  }
}
