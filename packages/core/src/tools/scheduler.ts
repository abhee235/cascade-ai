// tools/scheduler.ts — run a turn's tool calls with the right concurrency.

//
// Rule (ADR-008): consecutive concurrency-safe (read-only) tools run in PARALLEL; anything not safe
// (a write) runs SOLO. Parallelism is a correctness choice — independent reads can't interfere, but
// writes can race. Results are returned in the ORIGINAL order (tool_results map by id either way).

import type { ActivityEvent, ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { defaultRegistry, type ToolRegistry } from './toolRegistry'
import { executeTool, type ToolUse } from './runTool'
import { checkPermission } from '../permissions/gate'
import { NoopTracer } from '../observability/tracer'

function isSafe(tu: ToolUse, registry: ToolRegistry): boolean {
  try {
    return registry.find(tu.name)?.isConcurrencySafe?.(tu.input as never) ?? false // default: not safe
  } catch {
    return false
  }
}

function summary(tu: ToolUse, registry: ToolRegistry): string {
  try {
    return registry.find(tu.name)?.activitySummary(tu.input as never) ?? tu.name
  } catch {
    return tu.name
  }
}

/** Group consecutive safe tools into parallel batches; each unsafe tool is its own (serial) batch.
 *  Exported for unit testing — it's pure (no execution). Registry defaults to builtins-only. */
export function partition(toolUses: ToolUse[], registry: ToolRegistry = defaultRegistry): ToolUse[][] {
  const batches: ToolUse[][] = []
  let safeRun: ToolUse[] = []
  for (const tu of toolUses) {
    if (isSafe(tu, registry)) {
      safeRun.push(tu)
    } else {
      if (safeRun.length) batches.push(safeRun), (safeRun = [])
      batches.push([tu]) // unsafe → solo
    }
  }
  if (safeRun.length) batches.push(safeRun)
  return batches
}

/** A tool_result that records a denial — the model SEES this and adapts. The wording is DIRECTIVE on
 *  purpose: "Permission denied" alone reads like an OS EACCES error, so models retry or blame the
 *  filesystem/sandbox (observed in a trace). Tell it plainly the user chose No, and to stop and ask. */
function deniedBlock(id: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content:
      'The user declined this action via the approval prompt — a deliberate choice, not a filesystem ' +
      'or sandbox error. Do not retry it or suggest workarounds; briefly acknowledge and ask the user ' +
      'how they would like to proceed.',
    isError: true,
  }
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
  const tracer = ctx.tracer ?? NoopTracer
  const registry = ctx.registry ?? defaultRegistry // builtins + ready MCP tools (Phase 9)

  for (const batch of partition(toolUses, registry)) {
    // ── 1. GATE every tool first. Reads auto-allow instantly (no await); a write in 'default' mode
    //       returns 'ask', so we yield a card and PARK on perm.request() until the user clicks. ──
    const toRun: ToolUse[] = []
    for (const tu of batch) {
      const tool = registry.find(tu.name)
      let decision = tool && perm ? checkPermission(tool, tu.input, perm.state) : 'allow'
      const asked = decision === 'ask' // distinguishes a real prompt from an auto-allow in the trace
      if (decision === 'ask' && perm) {
        yield { type: 'permission', id: tu.id, tool: tu.name, detail: summary(tu, registry) }
        const answer = await perm.request(tu.id) // ← BLOCKS here until respondPermission(tu.id, …)
        if (answer === 'allow-always') perm.state.allow.add(tu.name) // remember for the rest of the session
        decision = answer === 'deny' ? 'deny' : 'allow'
      }
      tracer.event({ t: 'permission', id: tu.id, tool: tu.name, decision, asked }) // forensics: every gate verdict
      if (decision === 'deny') {
        byId.set(tu.id, deniedBlock(tu.id))
        yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
        yield { type: 'toolResult', id: tu.id, ok: false, preview: 'Denied' }
      } else {
        toRun.push(tu)
      }
    }

    // ── 2. RUN the allowed tools, STREAMING progress. A generator can't `yield` from inside the
    //       onProgress callback, so we BRIDGE: callbacks push chunks onto a queue and wake the loop,
    //       which drains them as toolProgress events while the tools run. (Safe batch = parallel reads;
    //       a solo mutating tool runs alone.) The single-threaded event loop guarantees no missed wakeup:
    //       nothing runs between our pending-check and the await that registers `wake`. ──
    for (const tu of toRun) {
      yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
      tracer.event({ t: 'tool_call', id: tu.id, name: tu.name, input: tu.input }) // full input, untruncated
    }
    // Think of this as a receptionist (this loop) sorting mail (`queue`) that workers (the tools) drop in.
    const queue: { id: string; chunk: string }[] = [] // mailbox: progress chunks waiting to be yielded
    let wake: (() => void) | null = null // the "resume button": set only while the loop is asleep
    const bump = () => {
      // Press the resume button (if the loop is asleep), waking it to drain the mailbox.
      const w = wake
      wake = null
      w?.()
    }
    const started = Date.now()
    let pending = toRun.length // how many tools are still running
    const settled = new Map<string, ContentBlock>()
    // Start every tool at once (parallel for a safe batch; just one for a solo tool). We do NOT await here —
    // each tool reports via callbacks: onProgress drops a chunk in the mailbox + rings the bell; .then
    // records the result, decrements pending, and rings the bell. The loop below does all the yielding.
    for (const tu of toRun) {
      executeTool(tu, ctx, (chunk) => (queue.push({ id: tu.id, chunk }), bump())).then((block) => {
        settled.set(tu.id, block)
        pending--
        bump()
      })
    }
    // Keep going while a tool is still running OR the mailbox has unsent chunks.
    while (pending > 0 || queue.length > 0) {
      while (queue.length) {
        // Drain the mailbox: this is the ONLY place a callback's chunk becomes a yielded event.
        const p = queue.shift()!
        yield { type: 'toolProgress', id: p.id, chunk: p.chunk }
      }
      if (pending === 0) break // all tools done and mailbox empty → finished
      // Sleep: save the resume button in `wake` and pause. A callback's bump() presses it to wake us.
      // (Single-threaded: nothing runs between the check above and this line, so no chunk is ever missed.)
      await new Promise<void>((res) => (wake = res))
    }
    const ms = Date.now() - started
    for (const tu of toRun) {
      const block = settled.get(tu.id)!
      byId.set(tu.id, block)
      const isError = block.type === 'tool_result' && !!block.isError
      const content = block.type === 'tool_result' ? block.content : ''
      const display = block.type === 'tool_result' ? block.display : undefined
      tracer.event({ t: 'tool_result', id: tu.id, name: tu.name, ok: !isError, ms, content })
      yield { type: 'toolResult', id: tu.id, ok: !isError, preview: content.slice(0, 200), display }
    }
  }

  return toolUses.map((tu) => byId.get(tu.id)!) // original order
}
