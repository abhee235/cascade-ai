// chatStore.ts — multiple chats per project (M11), persisted under the project's `.cascade/` dir so they
// survive server restarts. An index (chats.json) holds the chat list + which is active; each chat's core
// conversation lives in chat-<id>.json. The wsServer swaps a session's history (getHistory/loadHistory) when
// switching chats, so each chat has its own agent context. Server-only; the web app sees only chat metadata.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Message } from '@cascade/core'
import type { ChatMeta } from '@cascade/app-protocol'

const cascadeDir = (projectDir: string) => join(projectDir, '.cascade')
const indexPath = (projectDir: string) => join(cascadeDir(projectDir), 'chats.json')
const chatPath = (projectDir: string, id: string) => join(cascadeDir(projectDir), `chat-${id}.json`)
const newId = () => randomBytes(4).toString('hex')

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

  /** The project's chats (newest first), creating a first one if none exist. */
  list(projectDir: string): ChatMeta[] {
    let chats = this.readIndex(projectDir)
    if (chats.length === 0) {
      const m = this.create(projectDir)
      chats = [m]
    }
    return chats
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
  }
}
