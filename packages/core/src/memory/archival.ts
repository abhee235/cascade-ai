// memory/archival.ts — Tier 2 memory (ADR-015): an unbounded store of facts the agent writes and
// SEMANTICALLY SEARCHES on demand, so only relevant facts enter context (vs an always-injected memory
// file). Backed by local embeddings (Ollama /api/embeddings via ModelProvider.embed). Degrades to keyword
// search when no embedder is available, so it never hard-fails.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ArchivalEntry {
  id: string
  text: string
  embedding?: number[]
  ts: string
}
export interface ArchivalHit {
  text: string
  score: number
}
export interface ArchivalMemory {
  write(text: string): Promise<void>
  search(query: string, k?: number): Promise<ArchivalHit[]>
  count(): number
  list(): ArchivalEntry[]
  remove(id: string): void
}

/** Embed a batch of texts → one vector each. Bound to a provider+model by the session. */
export type Embed = (texts: string[]) => Promise<number[][]>

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

function load(path: string): ArchivalEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function createArchival(opts: { cwd: string; embed?: Embed; file?: string }): ArchivalMemory {
  const path = opts.file ?? join(opts.cwd, '.cascade', 'archival.json')
  const entries = load(path)

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8')
  }
  const tryEmbed = async (text: string): Promise<number[] | undefined> => {
    try {
      return opts.embed ? (await opts.embed([text]))[0] : undefined
    } catch {
      return undefined // embedder offline/unsupported → store text only, fall back to keyword search
    }
  }

  return {
    async write(text) {
      const t = text.trim()
      if (!t || entries.some((e) => e.text === t)) return // dedup exact repeats
      entries.push({ id: `m_${Date.now()}_${entries.length}`, text: t, embedding: await tryEmbed(t), ts: new Date().toISOString() })
      persist()
    },

    async search(query, k = 5) {
      if (!entries.length) return []
      const q = await tryEmbed(query)
      if (q) {
        // Semantic: cosine similarity over embedded entries.
        const scored = entries.filter((e) => e.embedding).map((e) => ({ text: e.text, score: cosine(q, e.embedding as number[]) }))
        return scored.sort((a, b) => b.score - a.score).slice(0, k)
      }
      // Degrade: token overlap (fraction of query words present in the entry) so natural-language queries
      // still match without an embedder — e.g. "how to deploy" matches "deploy with make ship".
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
      if (!words.length) return []
      return entries
        .map((e) => {
          const t = e.text.toLowerCase()
          const matched = words.filter((w) => t.includes(w)).length
          // Floor any match at 0.5 (so a meaningful keyword hit clears the retrieval threshold regardless of
          // how verbose the query is), scaling up with the fraction matched.
          return { text: e.text, score: matched ? 0.5 + 0.5 * (matched / words.length) : 0 }
        })
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
    },

    count: () => entries.length,
    list: () => entries.slice(),
    remove: (id) => {
      const i = entries.findIndex((e) => e.id === id)
      if (i >= 0) {
        entries.splice(i, 1)
        persist()
      }
    },
  }
}
