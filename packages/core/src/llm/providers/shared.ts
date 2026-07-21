// llm/providers/shared.ts — tiny helpers shared by every wire adapter's message translation.
// Each adapter (openaiChat, openaiResponses, ollama, …) owns its OWN wire-format translation; these two
// content-block primitives are the only genuinely shared pieces, so they live here to avoid a cycle.

import type { ContentBlock, Message } from '../../protocol'

/** Normalize a message's content to a block array (a bare string becomes one text block). */
export const asBlocks = (c: Message['content']): ContentBlock[] =>
  typeof c === 'string' ? [{ type: 'text', text: c }] : c

/** Concatenate all text blocks (drops tool_use / tool_result / image blocks). */
export const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
