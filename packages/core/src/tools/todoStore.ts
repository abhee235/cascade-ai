// tools/todoStore.ts — the authoritative current todo checklist, session-scoped, per agent (ADR-034).
//
// WHY this exists (and isn't just "read the last TodoWrite from the transcript"): the model resends the full
// list on every TodoWrite call, but that list lives only in the transcript — which COMPACTION can mask or
// summarize away mid-session. So the authoritative list lives in a small session store outside the transcript,
// and the UI and the periodic reminder read it from there — which survives compaction. It also optionally
// PERSISTS to `.cascade/todos.json`, so the checklist (and thus the reminder + a future reopen view) survives
// a server/extension restart, which an in-memory store would not. Keyed by agent depth so a subagent's list never clobbers the main agent's.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TodoItem } from '../protocol'

export class TodoStore {
  private readonly byScope = new Map<number, TodoItem[]>()

  /** `persistPath` (e.g. `<cwd>/.cascade/todos.json`) makes the list durable; omit it for in-memory use
   *  (headless tests). Loading is best-effort — a missing/corrupt file just starts empty. */
  constructor(private readonly persistPath?: string) {
    if (persistPath) this.load()
  }

  /** The current list for an agent scope (0 = main agent, 1+ = subagents). Never null — empty if unset. */
  get(scope = 0): TodoItem[] {
    return this.byScope.get(scope) ?? []
  }

  set(scope: number, items: TodoItem[]): void {
    this.byScope.set(scope, items)
    this.save()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.persistPath!, 'utf8')) as Record<string, TodoItem[]>
      for (const k of Object.keys(raw)) this.byScope.set(Number(k), raw[k])
    } catch {
      /* no file yet, or corrupt — start empty */
    }
  }

  private save(): void {
    if (!this.persistPath) return
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      const obj: Record<string, TodoItem[]> = {}
      for (const [k, v] of this.byScope) obj[String(k)] = v
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2))
    } catch {
      /* best-effort: persistence failure must never break a tool call */
    }
  }
}
