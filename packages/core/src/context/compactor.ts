// context/compactor.ts — keep the conversation within the model's window (ADR-012). Layered + ratio-sized:
//   Phase A  observation masking (cheap, no LLM): replace large OLD tool outputs with a placeholder.
//   Phase B  partial summarize (only if still over): summarize the OLDER half into one message via the
//            9-section structured prompt, keep the RECENT half verbatim.
// Returns NEW messages; the raw transcript + JSONL trace are untouched (the session swaps its history array).

import type { Message } from '../protocol'
import type { ModelProvider } from '../llm/provider'
import { contextWindowForModel } from '../llm/contextWindows'

export interface CompactConfig {
  window: number // total context window (tokens)
  compactRatio: number // compact when estimated tokens ≥ window * this (default 0.8)
  keepRecentRatio: number // keep this fraction of the window as verbatim recent messages (default 0.25)
}

/** window = explicit override → known-model map → safe default; ratios scale across 8k↔200k. */
export function resolveCompactConfig(opts: {
  model: string
  contextWindow?: number
  compactRatio?: number
  keepRecentRatio?: number
}): CompactConfig {
  return {
    window: opts.contextWindow ?? contextWindowForModel(opts.model) ?? 8192,
    compactRatio: opts.compactRatio ?? 0.8,
    keepRecentRatio: opts.keepRecentRatio ?? 0.25,
  }
}

/** Rough token estimate (chars/4) over serialized content — no tokenizer dependency. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else
      for (const b of m.content) {
        if (b.type === 'text') chars += b.text.length
        else if (b.type === 'thinking') chars += b.thinking.length
        else if (b.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length
        else if (b.type === 'tool_result') chars += b.content.length
      }
  }
  return Math.ceil(chars / 4)
}

/** Index splitting [older | recent]: keep the most-recent messages that fit within keepRecentTokens verbatim;
 *  everything before is "older". Returns the boundary index (older = [0..idx), recent = [idx..]). */
export function olderBoundary(messages: Message[], keepRecentTokens: number): number {
  let acc = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]])
    if (acc > keepRecentTokens) return i + 1 // including message i would overflow the recent window
  }
  return 0 // it all fits in the recent window → nothing older
}

/** Phase A: replace large tool_result blocks in the OLDER region with a placeholder (keep the reasoning). */
export function maskObservations(messages: Message[], olderCount: number, maxToolChars = 2000): Message[] {
  return messages.map((m, idx) => {
    if (idx >= olderCount || typeof m.content === 'string') return m
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === 'tool_result' && b.content.length > maxToolChars
          ? { ...b, content: `[output masked — ${b.content.length} chars elided to save context]` }
          : b,
      ),
    }
  })
}

// The structured summary prompt: seven headings built around what the agent needs to resume (where the work
// stands, which files matter, what was decided) rather than a chronological retelling. TEXT ONLY.
const COMPACT_SYSTEM = `You are summarizing the EARLIER part of a coding conversation so it can be replaced by your summary while the recent messages are kept verbatim. Be thorough on the technical detail needed to continue the work without losing context. Reply in plain text only; make no tool calls.

Write the summary under these headings:
- Goal — what the user wants, in their own words where it matters.
- State of the work — what is done, what is half-done, and exactly where it stopped.
- Files — every file created or changed: its path, what it is for, and any snippet the work still depends on.
- Decisions and constraints — what was decided and why, and every rule the user set.
- Problems and fixes — errors met, what fixed them, and any correction the user made.
- User messages — each one in order, briefly.
- Next — the next action, only if the latest request calls for it; quote the last line of work so it resumes in place.`

function serialize(messages: Message[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) =>
                b.type === 'text'
                  ? b.text
                  : b.type === 'thinking'
                    ? `(thinking) ${b.thinking}`
                    : b.type === 'tool_use'
                      ? `(tool ${b.name} ${JSON.stringify(b.input ?? {})})`
                      : b.type === 'tool_result'
                        ? `(result) ${b.content}`
                        : '',
              )
              .join('\n')
      return `${m.role.toUpperCase()}: ${text}`
    })
    .join('\n\n')
}

async function summarize(older: Message[], provider: ModelProvider, model: string, signal?: AbortSignal): Promise<string> {
  const res = await provider.complete({ messages: [{ role: 'user', content: serialize(older) }], model, system: COMPACT_SYSTEM }, signal)
  return res.text.trim()
}

export interface CompactDeps {
  provider: ModelProvider
  model: string
  config: CompactConfig
  signal?: AbortSignal
  /** Coupled curation (ADR-015): harvest durable facts from the OLDER messages before they're compressed. */
  onDiscard?: (older: Message[]) => Promise<void>
}

export type CompactionKind = 'none' | 'masked' | 'summarized'

/** Compact `messages` if over threshold. Returns the (possibly) new history and what was done. */
export async function compactIfNeeded(messages: Message[], deps: CompactDeps): Promise<{ messages: Message[]; kind: CompactionKind }> {
  const compactAt = deps.config.window * deps.config.compactRatio
  if (estimateTokens(messages) < compactAt) return { messages, kind: 'none' }

  const keepRecent = deps.config.window * deps.config.keepRecentRatio
  const boundary = olderBoundary(messages, keepRecent)

  // Phase A — mask large old tool outputs; often enough on its own.
  const masked = maskObservations(messages, boundary)
  if (estimateTokens(masked) < compactAt || boundary === 0) {
    return { messages: masked, kind: boundary === 0 ? 'none' : 'masked' }
  }

  // Phase B — summarize the older half (harvest memory first), keep recent verbatim.
  const older = masked.slice(0, boundary)
  const recent = masked.slice(boundary)
  if (deps.onDiscard) await deps.onDiscard(older)
  const summary = await summarize(older, deps.provider, deps.model, deps.signal)
  const summaryMsg: Message = { role: 'user', content: `[Earlier conversation compacted to save context]\n\n${summary}` }
  return { messages: [summaryMsg, ...recent], kind: 'summarized' }
}
