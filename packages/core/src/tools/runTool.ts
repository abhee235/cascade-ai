// tools/runTool.ts — execute one tool call → a tool_result block.

//
// Pipeline: lookup by name → Zod validate → call → wrap result. Errors are RETURNED as the result
// (isError:true), never thrown — so the model sees what went wrong and can self-correct (Phase 5 idea).

import type { ContentBlock } from '../protocol'
import { RAW_ARGS_KEY } from '../llm/jsonRepair'
import type { ToolContext } from './Tool'
import { describeInvalidInput, normalizeInput, schemaKeys } from './inputNormalizer'
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

  // Item 4a: the provider could not parse the arguments as JSON at all (repair ladder exhausted). Say THAT —
  // schema-validating the sentinel would produce "missing required file_path", a lie pointing away from the
  // model's actual mistake (its own JSON syntax). Echo what it sent so the retry has something to fix.
  const rawArgs = (toolUse.input as Record<string, unknown> | null)?.[RAW_ARGS_KEY]
  if (typeof rawArgs === 'string') {
    const keys = tool.inputSchema ? schemaKeys(tool.inputSchema) : null
    return err(
      `${toolUse.name} was called with MALFORMED arguments — not valid JSON, and not mechanically repairable. ` +
        `You sent: ${rawArgs.slice(0, 300)}${rawArgs.length > 300 ? '…' : ''}. ` +
        `Call ${toolUse.name} again with ONE valid JSON object${keys ? ` using these keys: ${keys.join(', ')}` : ''}.`,
    )
  }

  // Builtins validate with Zod (and feed errors back so the model self-corrects). MCP tools have no Zod
  // schema — the server validates — so we forward the args as-is.
  let input = toolUse.input
  if (tool.inputSchema) {
    let parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      // ADR-048: weak models send the right VALUE under the wrong KEY (Read{path:…} — the 3B's dominant
      // invalid_args mode). Try conservative alias normalization, then re-validate once.
      const normalized = normalizeInput(toolUse.input, tool.inputSchema)
      if (normalized) parsed = tool.inputSchema.safeParse(normalized)
      if (!parsed.success) {
        // Compact, DIRECTIVE error — the raw Zod dump made the 3B retry the identical wrong call 4×.
        return err(describeInvalidInput(toolUse.name, toolUse.input, tool.inputSchema, parsed.error.message))
      }
    }
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
