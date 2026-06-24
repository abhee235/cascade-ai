// tools/scheduler.ts — run a turn's tool calls with the right concurrency.

//
// Rule (ADR-008): consecutive concurrency-safe (read-only) tools run in PARALLEL; anything not safe
// (a write) runs SOLO. Parallelism is a correctness choice — independent reads can't interfere, but
// writes can race. Results are returned in the ORIGINAL order (tool_results map by id either way).

import type { ActivityEvent, ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { findTool } from './toolRegistry'
import { executeTool, type ToolUse } from './runTool'
import { checkPermission } from '../permissions/gate'

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

/** A tool_result that records a denial — the model SEES this and can adapt (e.g. ask, or try another way). */
function deniedBlock(id: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: id, content: 'Permission denied by the user.', isError: true }
}

/** Yields toolStart/permission/toolResult activity; returns the tool_result blocks in original order.
 *  Phase 7: each tool passes through checkPermission BEFORE it runs. 'allow' → run; 'deny' → error result,
 *  no execution; 'ask' → yield a `permission` event and AWAIT the user (this is what blocks the loop). */
export async function* scheduleTools(
  toolUses: ToolUse[],
  ctx: ToolContext,
): AsyncGenerator<ActivityEvent, ContentBlock[]> {
  const byId = new Map<string, ContentBlock>()
  const perm = ctx.permission

  for (const batch of partition(toolUses)) {
    // ── 1. GATE every tool first. Reads auto-allow instantly (no await); a write in 'default' mode
    //       returns 'ask', so we yield a card and PARK on perm.request() until the user clicks. ──
    const toRun: ToolUse[] = []
    for (const tu of batch) {
      const tool = findTool(tu.name)
      let decision = tool && perm ? checkPermission(tool, tu.input, perm.state) : 'allow'
      if (decision === 'ask' && perm) {
        yield { type: 'permission', id: tu.id, tool: tu.name, detail: summary(tu) }
        const answer = await perm.request(tu.id) // ← BLOCKS here until respondPermission(tu.id, …)
        if (answer === 'allow-always') perm.state.allow.add(tu.name) // remember for the rest of the session
        decision = answer === 'deny' ? 'deny' : 'allow'
      }
      if (decision === 'deny') {
        byId.set(tu.id, deniedBlock(tu.id))
        yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu) }
        yield { type: 'toolResult', id: tu.id, ok: false, preview: 'Denied' }
      } else {
        toRun.push(tu)
      }
    }

    // ── 2. RUN the allowed tools. A safe batch (multiple reads) runs in parallel; a solo write alone. ──
    for (const tu of toRun) yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu) }
    const blocks = await Promise.all(toRun.map((tu) => executeTool(tu, ctx)))
    for (let i = 0; i < toRun.length; i++) {
      const block = blocks[i]
      byId.set(toRun[i].id, block)
      const isError = block.type === 'tool_result' && !!block.isError
      const preview = block.type === 'tool_result' ? block.content.slice(0, 200) : ''
      yield { type: 'toolResult', id: toRun[i].id, ok: !isError, preview }
    }
  }

  return toolUses.map((tu) => byId.get(tu.id)!) // original order
}
