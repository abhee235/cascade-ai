// tools/toolRegistry.ts — assembles the active tool list + lookup by name.
// Grows in later phases.

import { z } from 'zod'
import type { Tool } from './Tool'
import type { ToolSchema } from '../llm/provider'
import { ReadTool } from './builtins/Read'

export const tools: Tool[] = [ReadTool]

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

/** Convert the registry to schemas for the model (Zod → JSON Schema). */
export function toolSchemas(): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
  }))
}
