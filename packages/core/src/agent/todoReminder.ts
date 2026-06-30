// agent/todoReminder.ts — re-ground the model on its task checklist when it drifts from it (ADR-034).
//
// WHY: TodoWrite only helps if the model KEEPS the list current. Over a long session it forgets to update it —
// it "moves on without updating". The fix is to re-inject the current list as a <system-reminder> once
// enough idle assistant turns pass with no TodoWrite call.
//
// We count those turns and make the reminder STATE-AWARE: empty vs in-progress vs all-done vs
// invariant-violating lists each get a DIFFERENT directive (not one static nag). The reminder carries a
// sentinel so our own turn-counter can find the last one it injected and not re-nag every turn.

import type { ContentBlock, Message, TodoItem } from '../protocol'

/** Marker embedded in every injected reminder so `todoReminderCounts` can detect "turns since last reminder"
 *  without a separate message type (it rides a normal user message). */
export const TODO_REMINDER_SENTINEL = '[todo-checklist-status]'

export interface TodoReminderConfig {
  /** Idle assistant turns since the last TodoWrite before we re-remind. */
  turnsSinceWrite: number
  /** Minimum assistant turns between two reminders, so we never nag back-to-back. */
  turnsBetweenReminders: number
}
// Fairly eager (6/6) — Cascade sessions (local models, a single build task) are short, so a
// drifting checklist should be re-grounded soon. Injectable via LoopDeps for tuning/tests.
export const DEFAULT_TODO_REMINDER_CONFIG: TodoReminderConfig = { turnsSinceWrite: 6, turnsBetweenReminders: 6 }

const blocksOf = (m: Message): ContentBlock[] =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
const hasTodoWrite = (m: Message): boolean =>
  m.role === 'assistant' && blocksOf(m).some((b) => b.type === 'tool_use' && b.name === 'TodoWrite')
const isReminder = (m: Message): boolean =>
  m.role === 'user' && blocksOf(m).some((b) => b.type === 'text' && b.text.includes(TODO_REMINDER_SENTINEL))

/** Assistant turns since the last TodoWrite tool_use and since the last injected reminder (scanning history
 *  backward — robust across user messages, no counter state). */
export function todoReminderCounts(messages: Message[]): { sinceWrite: number; sinceReminder: number } {
  let sinceWrite = 0
  let sinceReminder = 0
  let foundWrite = false
  let foundReminder = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      if (!foundWrite && hasTodoWrite(m)) foundWrite = true
      if (!foundWrite) sinceWrite++
      if (!foundReminder) sinceReminder++
    } else if (!foundReminder && isReminder(m)) {
      foundReminder = true
    }
    if (foundWrite && foundReminder) break
  }
  return { sinceWrite, sinceReminder }
}

/** Decide whether to inject a reminder this turn. We only chase a list that exists and still has open work —
 *  an empty or fully-completed list gets no nag (we don't pester a model that isn't mid-task). */
export function shouldRemindTodos(
  messages: Message[],
  items: TodoItem[],
  cfg: TodoReminderConfig = DEFAULT_TODO_REMINDER_CONFIG,
): boolean {
  if (items.length === 0) return false
  if (items.every((t) => t.status === 'completed')) return false
  const { sinceWrite, sinceReminder } = todoReminderCounts(messages)
  return sinceWrite >= cfg.turnsSinceWrite && sinceReminder >= cfg.turnsBetweenReminders
}

/** The state-aware reminder text, wrapped in <system-reminder> and carrying the sentinel. The directive adapts
 *  to the list's actual state, so it's a useful instruction — not a single fixed string. */
export function buildTodoReminder(items: TodoItem[]): string {
  const glyph = (s: TodoItem['status']) => (s === 'completed' ? '✔' : s === 'in_progress' ? '▶' : '☐')
  const list = items
    .map((t, i) => `  ${glyph(t.status)} ${i + 1}. ${t.content}${t.status === 'in_progress' ? ` — ${t.activeForm}` : ''}`)
    .join('\n')
  const inProgress = items.filter((t) => t.status === 'in_progress').length
  const pending = items.filter((t) => t.status === 'pending').length

  let directive: string
  if (inProgress > 1) {
    directive = `You have ${inProgress} tasks in_progress — keep exactly ONE. Set the others back to pending or mark them completed with TodoWrite.`
  } else if (inProgress === 0 && pending > 0) {
    directive = `No task is in_progress. Before you continue, mark the next task in_progress with TodoWrite.`
  } else {
    directive = `Keep this current: mark a task completed the moment it's done and move to the next. If the work has drifted from this list, call TodoWrite now with the full updated list.`
  }
  return `<system-reminder>\n${TODO_REMINDER_SENTINEL} Your task checklist (the user tracks progress by it):\n${list}\n\n${directive}\nNever mention this reminder to the user.\n</system-reminder>`
}
