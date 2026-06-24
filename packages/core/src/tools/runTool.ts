// tools/runTool.ts — execute one tool call → a tool_result block.

//
// Pipeline: lookup by name → Zod validate → call → wrap result. Errors are RETURNED as the result
// (isError:true), never thrown — so the model sees what went wrong and can self-correct (Phase 5 idea).

import type { ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { findTool } from './toolRegistry'

export interface ToolUse {
  id: string
  name: string
  input: unknown
}

export async function executeTool(
  toolUse: ToolUse,
  ctx: ToolContext,
  onProgress?: (chunk: string) => void,
): Promise<ContentBlock> {
  const err = (content: string): ContentBlock => ({
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content,
    isError: true,
  })

  const tool = findTool(toolUse.name)
  if (!tool) return err(`No such tool: ${toolUse.name}`)

  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) return err(`Invalid input for ${toolUse.name}: ${parsed.error.message}`)

  try {
    const result = await tool.call(parsed.data, ctx, onProgress)
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: result.content,
      isError: result.isError,
    }
  } catch (e) {
    return err(`${toolUse.name} threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}
