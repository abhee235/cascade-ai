// tools/runTool.ts — execute one tool call → a tool_result block.

//
// Pipeline: lookup by name → Zod validate → call → wrap result. Errors are RETURNED as the result
// (isError:true), never thrown — so the model sees what went wrong and can self-correct (Phase 5 idea).

import type { ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { defaultRegistry } from './toolRegistry'

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

  const tool = (ctx.registry ?? defaultRegistry).find(toolUse.name)
  if (!tool) return err(`No such tool: ${toolUse.name}`)

  // Builtins validate with Zod (and feed errors back so the model self-corrects). MCP tools have no Zod
  // schema — the server validates — so we forward the args as-is.
  let input = toolUse.input
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) return err(`Invalid input for ${toolUse.name}: ${parsed.error.message}`)
    input = parsed.data
  }

  try {
    const result = await tool.call(input, ctx, onProgress)
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: result.content,
      isError: result.isError,
      display: result.display, // M2: UI rendering hint (e.g. a file-edit diff) — passed through to the frontend
    }
  } catch (e) {
    return err(`${toolUse.name} threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}
