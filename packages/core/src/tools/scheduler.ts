// tools/scheduler.ts — run a turn's tool calls with the right concurrency.

//
// Rule (ADR-008): consecutive concurrency-safe (read-only) tools run in PARALLEL; anything not safe
// (a write) runs SOLO. Parallelism is a correctness choice — independent reads can't interfere, but
// writes can race. Results are returned in the ORIGINAL order (tool_results map by id either way).

import type { ActivityEvent, ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { findTool } from './toolRegistry'
import { executeTool, type ToolUse } from './runTool'

function isSafe(tu: ToolUse): boolean {
  try {
    return findTool(tu.name)?.isConcurrencySafe?.(tu.input as never) ?? false // default: not safe
  } catch {
    return false
  }
}

function summary(tu: ToolUse): string {
  try {
    return findTool(tu.name)?.activitySummary(tu.input as never) ?? tu.name
  } catch {
    return tu.name
  }
}

/** Group consecutive safe tools into parallel batches; each unsafe tool is its own (serial) batch.
 *  Exported for unit testing — it's pure (no execution). */
export function partition(toolUses: ToolUse[]): ToolUse[][] {
  const batches: ToolUse[][] = []
  let safeRun: ToolUse[] = []
  for (const tu of toolUses) {
    if (isSafe(tu)) {
      safeRun.push(tu)
    } else {
      if (safeRun.length) batches.push(safeRun), (safeRun = [])
      batches.push([tu]) // unsafe → solo
    }
  }
  if (safeRun.length) batches.push(safeRun)
  return batches
}

/** Yields toolStart/toolResult activity; returns the tool_result blocks in original order. */
export async function* scheduleTools(
  toolUses: ToolUse[],
  ctx: ToolContext,
): AsyncGenerator<ActivityEvent, ContentBlock[]> {
  const byId = new Map<string, ContentBlock>()

  for (const batch of partition(toolUses)) {
    for (const tu of batch) yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu) }

    // A safe batch (len>1) runs in parallel; a solo batch just runs its one tool.
    const blocks = await Promise.all(batch.map((tu) => executeTool(tu, ctx)))

    for (let i = 0; i < batch.length; i++) {
      const block = blocks[i]
      byId.set(batch[i].id, block)
      const isError = block.type === 'tool_result' && !!block.isError
      const preview = block.type === 'tool_result' ? block.content.slice(0, 200) : ''
      yield { type: 'toolResult', id: batch[i].id, ok: !isError, preview }
    }
  }

  return toolUses.map((tu) => byId.get(tu.id)!) // original order
}
