// memory/curator.ts — SELF-CURATION (ADR-015, Tier 3): at the end of a completed turn, a focused pass
// extracts durable facts from the conversation and saves them — so the agent "remembers without being told"
// (a background extraction pass, off the main turn). We write to ARCHIVAL (searchable, retrieved on
// demand) rather than always-injected core memory, so a bad extraction has a small blast radius; core stays
// explicit (the Memory tool / hand-edit). Markers surface every save so it's transparent.

import type { Message } from '../protocol'
import type { ModelProvider } from '../llm/provider'
import type { ArchivalMemory } from './archival'

const EXTRACT_SYSTEM =
  'You extract DURABLE facts worth remembering across sessions from a conversation: user preferences, ' +
  'project conventions, decisions, and stable facts. IGNORE transient or task-specific details. ' +
  'Output ONLY a JSON array of short strings, e.g. ["prefers tabs over spaces","deploys via make ship"]. ' +
  'At most 3. If nothing durable, output [].'

/** Flatten the last few messages to plain text for the extractor. */
function conversationText(messages: Message[], maxMsgs = 8): string {
  return messages
    .slice(-maxMsgs)
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
      return text.trim() ? `${m.role}: ${text.trim()}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Parse the model's reply into ≤3 fact strings. Defensive: local models emit messy JSON, so we grab the
 *  first [...] and validate; any failure ⇒ [] (no-op, never throws). */
export function parseFacts(raw: string): string[] {
  try {
    const m = raw.match(/\[[\s\S]*\]/)
    if (!m) return []
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => (typeof x === 'string' ? x : x?.text))
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim())
      .slice(0, 3)
  } catch {
    return []
  }
}

/** Run extraction and persist facts to archival memory. Returns the saved facts (for UI markers/trace). */
export async function curateMemory(opts: {
  messages: Message[]
  provider: ModelProvider
  model: string
  archival?: ArchivalMemory
}): Promise<string[]> {
  if (!opts.archival) return []
  const convo = conversationText(opts.messages)
  if (!convo) return []
  let reply = ''
  try {
    reply = (await opts.provider.complete({ messages: [{ role: 'user', content: convo }], model: opts.model, system: EXTRACT_SYSTEM })).text
  } catch {
    return [] // extraction is best-effort; never break the turn
  }
  const facts = parseFacts(reply)
  for (const f of facts) await opts.archival.write(f)
  return facts
}
