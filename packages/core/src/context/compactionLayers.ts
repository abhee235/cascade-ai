// context/compactionLayers.ts — the pure, no-LLM compaction layers (ADR-039). Each is a history transform
// that reclaims tokens from the OLDER region (indices < olderCount) while leaving the recent-verbatim window
// and all reasoning/text untouched. The orchestrator (compactor.ts) runs the enabled layers cheapest-first,
// escalating to the LLM summary only if they don't free enough.
//
// Built for a local, provider-neutral history array (no server-side cache-edit API). Beyond the usual cheap
// layers, which all clear tool *outputs*, we ALSO reclaim large tool *inputs* (Write/Edit file bodies) via
// `snip` — the single largest reclaimable item in a coding session, which output-clearing never touches.

import type { ContentBlock, Message } from '../protocol'

/**
 * Tools whose results are safe to evict — bulky, re-derivable observations. Deliberately EXCLUDES tools whose
 * result is load-bearing state the model must keep verbatim (TodoWrite, Memory/MemorySearch, Subagent, and any
 * MCP tool).
 */
export const COMPACTABLE_TOOLS = new Set<string>(['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write'])

/** Tools that read/search — their results dedupe cleanly by target (used by `collapse`). */
const READ_SEARCH_TOOLS = new Set<string>(['Read', 'Grep', 'Glob'])
/** Tools whose INPUT can be huge (a full file body / long script) — targeted by `snip`. */
const LARGE_INPUT_TOOLS = new Set<string>(['Write', 'Edit', 'Bash'])

// Content markers. Kept human-readable so the model understands why the bytes are gone (and so `snip` can
// recognise an already-spent result). `isClearedContent` is the single source of truth for "already evicted".
const MASK_PREFIX = '[output masked'
export const SUPERSEDED_MARKER =
  '[Superseded — a newer read/search of the same target appears later; this stale copy was cleared to save context.]'
export const CLEARED_MARKER = '[Old tool result content cleared to save context.]'

/** True if a tool_result's content was already evicted by an earlier layer (mask/collapse/microcompact). */
export function isClearedContent(content: string): boolean {
  return (
    content.startsWith(MASK_PREFIX) ||
    content === SUPERSEDED_MARKER ||
    content === CLEARED_MARKER
  )
}

export type CompactionKind =
  | 'none'
  | 'collapsed'
  | 'masked'
  | 'microcompacted'
  | 'snipped'
  | 'summarized'

/** Human label for the `compacted` activity event (single source of truth for both UIs). */
export function compactionKindLabel(kind: string): string {
  switch (kind) {
    case 'collapsed':
      return 'collapsed superseded reads/searches'
    case 'masked':
      return 'masked large old tool output'
    case 'microcompacted':
      return 'cleared old tool results'
    case 'snipped':
      return 'snipped large tool inputs'
    case 'summarized':
      return 'summarized older turns'
    default:
      return 'compacted context'
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const asBlocks = (m: Message): ContentBlock[] | null =>
  typeof m.content === 'string' ? null : m.content

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** Map tool_use id → tool name across the whole history (results carry only the id). */
function toolNameById(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    const blocks = asBlocks(m)
    if (!blocks) continue
    for (const b of blocks) if (b.type === 'tool_use') map.set(b.id, b.name)
  }
  return map
}

/** A stable dedupe key for a read/search tool_use, or null if it isn't dedupable. */
function dedupeKey(block: ToolUseBlock): string | null {
  const input = (block.input ?? {}) as { file_path?: string; path?: string; pattern?: string; glob?: string }
  switch (block.name) {
    case 'Read':
      return input.file_path ? `read:${input.file_path}` : null
    case 'Grep':
      return `grep:${input.pattern ?? ''}:${input.path ?? ''}:${input.glob ?? ''}`
    case 'Glob':
      return `glob:${input.pattern ?? ''}:${input.path ?? ''}`
    default:
      return null
  }
}

/** Rewrite the tool_result blocks of `message` whose id is in `ids` (and not already cleared) to `marker`. */
function clearResults(message: Message, ids: Set<string>, marker: string): Message {
  const blocks = asBlocks(message)
  if (!blocks) return message
  let touched = false
  const next = blocks.map((b) => {
    if (b.type === 'tool_result' && ids.has(b.tool_use_id) && !isClearedContent(b.content)) {
      touched = true
      return { ...b, content: marker }
    }
    return b
  })
  return touched ? { ...message, content: next } : message
}

// ── Layer: collapse (dedup superseded reads/searches) ──────────────────────────────────────────────────────
/**
 * Clear the results of read/search operations that are SUPERSEDED — the same file was read again, or the same
 * Grep/Glob was re-run, later in the conversation. The freshest copy is kept; the stale earlier copies (in the
 * OLDER region) are cleared. Lossless in practice: the newer read reflects current state. Cheapest, safest layer.
 */
export function collapseSuperseded(messages: Message[], olderCount: number): Message[] {
  // For each dedupe key, remember the LAST (latest) tool_use id that carries it.
  const latestIdForKey = new Map<string, string>()
  for (const m of messages) {
    const blocks = asBlocks(m)
    if (!blocks) continue
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !READ_SEARCH_TOOLS.has(b.name)) continue
      const key = dedupeKey(b)
      if (key) latestIdForKey.set(key, b.id) // later occurrences overwrite → holds the latest
    }
  }
  // An id is superseded if its key's latest id is a DIFFERENT (later) tool_use.
  const superseded = new Set<string>()
  for (const m of messages) {
    const blocks = asBlocks(m)
    if (!blocks) continue
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !READ_SEARCH_TOOLS.has(b.name)) continue
      const key = dedupeKey(b)
      if (key && latestIdForKey.get(key) !== b.id) superseded.add(b.id)
    }
  }
  if (superseded.size === 0) return messages
  return messages.map((m, idx) => (idx < olderCount ? clearResults(m, superseded, SUPERSEDED_MARKER) : m))
}

// ── Layer: mask (size-gated eviction of any oversized old tool output) ──────────────────────────────────────
/**
 * Replace tool_result blocks in the OLDER region whose content exceeds `maxToolChars` with a short placeholder.
 * Name-agnostic on purpose: the size gate is the safety valve (small, load-bearing results stay). This is the
 * historical Phase-A behaviour, preserved as the `mask` layer.
 */
export function maskObservations(messages: Message[], olderCount: number, maxToolChars = 2000): Message[] {
  let changed = false
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m
    const blocks = asBlocks(m)
    if (!blocks) return m
    let touched = false
    const next = blocks.map((b) => {
      if (b.type === 'tool_result' && !isClearedContent(b.content) && b.content.length > maxToolChars) {
        touched = true
        return { ...b, content: `[output masked — ${b.content.length} chars elided to save context]` }
      }
      return b
    })
    if (!touched) return m
    changed = true
    return { ...m, content: next }
  })
  return changed ? out : messages // no-op ⇒ same reference (uniform with the other layers)
}

// ── Layer: microcompact (evict all remaining compactable tool results) ──────────────────────────────────────
/**
 * Clear the content of EVERY remaining compactable tool_result in the OLDER region, regardless of size — the
 * aggressive observation-eviction layer. Keyed on the
 * tool NAME (COMPACTABLE_TOOLS) so load-bearing results (TodoWrite, Memory, MCP) are never touched.
 */
export function microcompactToolResults(messages: Message[], olderCount: number): Message[] {
  const names = toolNameById(messages)
  let changed = false
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m
    const blocks = asBlocks(m)
    if (!blocks) return m
    let touched = false
    const next = blocks.map((b) => {
      if (
        b.type === 'tool_result' &&
        !isClearedContent(b.content) &&
        COMPACTABLE_TOOLS.has(names.get(b.tool_use_id) ?? '')
      ) {
        touched = true
        return { ...b, content: CLEARED_MARKER }
      }
      return b
    })
    if (!touched) return m
    changed = true
    return { ...m, content: next }
  })
  return changed ? out : messages // no-op ⇒ same reference
}

// ── Layer: snip (reclaim large tool INPUTS) ─────────────────────────────────────────────────────────────────
/**
 * Reclaim the largest bytes the output-clearing layers can't touch: big tool_use INPUTS (a Write's full file
 * body, an Edit's old/new strings, a long Bash script) in the OLDER region. The input is replaced with a compact
 * stub that PRESERVES the record ("Write src/foo.ts — 8.2k chars elided") so the model still knows the operation
 * happened. This is our step beyond cheap output-clearing layers, which only ever clear outputs.
 */
export function snipLargeToolInputs(messages: Message[], olderCount: number, maxInputChars: number): Message[] {
  let changed = false
  const out = messages.map((m, idx) => {
    if (idx >= olderCount) return m
    const blocks = asBlocks(m)
    if (!blocks) return m
    let touched = false
    const next = blocks.map((b) => {
      if (b.type !== 'tool_use' || !LARGE_INPUT_TOOLS.has(b.name)) return b
      const json = JSON.stringify(b.input ?? {})
      if (json.length <= maxInputChars) return b
      const stub = stubForToolUse(b, json.length)
      if (stub === b.input) return b
      touched = true
      return { ...b, input: stub }
    })
    if (!touched) return m
    changed = true
    return { ...m, content: next }
  })
  return changed ? out : messages // no-op ⇒ same reference
}

/** Build a tiny descriptor object for a large tool_use input, keeping the identifying field, dropping the body. */
function stubForToolUse(block: ToolUseBlock, chars: number): unknown {
  const input = (block.input ?? {}) as { file_path?: string; command?: string; _compacted?: boolean }
  if (input._compacted) return input // already snipped — idempotent
  const where = input.file_path ? ` ${input.file_path}` : ''
  return { _compacted: true, note: `${block.name}${where} — input elided (${chars} chars) to save context` }
}

// Re-export the block subtypes callers occasionally need.
export type { ToolUseBlock, ToolResultBlock }
