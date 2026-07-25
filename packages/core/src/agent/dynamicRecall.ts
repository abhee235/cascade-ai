// ADR-074 — DYNAMIC archival recall. The static recall (session.ts) is embedded ONCE at submit-start into the
// system-prompt PREFIX: cache-safe (frozen) but blind to anything learned mid-build. A long build discovers a
// durable fact early ("the CTA colour comes from theme.primary, not the button"), compaction later summarises
// the turn that held it away, and 60 turns on the model re-diagnoses it from scratch — the fix-loop we measured.
//
// This closes that gap WITHOUT breaking the two things we spent days protecting:
//  • the KV cache — recall is appended at the TAIL (appendReminder), never the system prefix. A changing prefix
//    re-prefills the whole window every turn; a changing tail is just new tokens after the cached prefix.
//  • the single-runner load — search embeds the query via the same Ollama that runs the main model. MEASURED
//    (2026-07-24): nomic-embed-text CO-RESIDES with qwen36 (`ollama ps` shows both after an embed; qwen is not
//    evicted), so a per-turn search never triggers the model reload we fought in ADR-038/061.
//
// Precision over recall: injected at the tail every turn, a wrong memory is pure noise the model must read past,
// so the score bar is HIGHER than static recall (0.6 vs 0.45) and each fact is surfaced ONCE per session.

import type { ArchivalMemory } from '../memory/archival'
import type { ContentBlock, Message } from '../protocol'

/** Only surface a hit this strong at the tail. Higher than static recall's 0.45: a per-turn tail injection that
 *  misses is noise on EVERY subsequent turn's prefill, so we'd rather stay silent than inject a weak match. */
export const DYNAMIC_RECALL_MIN_SCORE = 0.6

/** Pull the model's CURRENT focus as the search query: the most recent assistant text (what it just said it was
 *  doing) plus any trailing user instruction — NOT tool_result blobs (a pasted file is noise that drowns the
 *  intent signal). Capped so the embed query stays cheap and on-topic. Empty ⇒ caller skips the search. */
export function recentFocusText(messages: Message[], maxChars = 600): string {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0 && parts.join(' ').length < maxChars; i--) {
    const m = messages[i]
    const text = typeof m.content === 'string' ? m.content : m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ')
    if (!text.trim()) continue
    // A user message that is ONLY tool_results carries no text blocks → skipped above. Real assistant reasoning
    // and genuine user text are what we want; take them newest-first until we have enough signal.
    if (m.role === 'assistant' || m.role === 'user') parts.push(text.trim())
    if (m.role === 'assistant') break // one assistant turn of intent is the strongest signal; stop there
  }
  return parts.join(' ').slice(0, maxChars).trim()
}

/** From ranked hits, keep the strong ones not already surfaced this session, and MARK them surfaced (mutates the
 *  set) so a fact is injected exactly once. Pure aside from that set mutation — unit-testable without embeddings. */
export function selectNewRecall(hits: { text: string; score: number }[], surfaced: Set<string>, minScore = DYNAMIC_RECALL_MIN_SCORE): string[] {
  const fresh: string[] = []
  for (const h of hits) {
    if (h.score < minScore) continue
    const key = h.text.trim()
    if (!key || surfaced.has(key)) continue
    surfaced.add(key)
    fresh.push(key)
  }
  return fresh
}

/** Format the fresh facts as a <system-reminder> for appendReminder. Framed as recall, not instruction, so the
 *  model weighs it rather than blindly obeying a possibly-stale memory. */
export function buildRecallReminder(texts: string[]): string {
  const body = texts.map((t) => `- ${t}`).join('\n')
  return `<system-reminder>Relevant facts recalled from earlier in this build (verify against the current code before acting on them):\n${body}</system-reminder>`
}

/** Orchestrates one turn's dynamic recall: search on the current focus, surface only strong NEW hits. Returns the
 *  reminder text to append, or null (nothing to add). `lastQuery` throttles redundant embeds — mid-tool-loop the
 *  focus text is unchanged across turns, so re-embedding it would burn latency for an identical result. */
export async function recallForTurn(opts: { archival: ArchivalMemory; query: string; surfaced: Set<string>; lastQuery?: string; k?: number; minScore?: number }): Promise<string | null> {
  const { archival, query, surfaced, lastQuery, k = 4, minScore } = opts
  if (!query || query === lastQuery || archival.count() === 0) return null
  const hits = await archival.search(query, k)
  const fresh = selectNewRecall(hits, surfaced, minScore)
  return fresh.length ? buildRecallReminder(fresh) : null
}
