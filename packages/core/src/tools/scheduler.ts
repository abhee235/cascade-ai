// tools/scheduler.ts — run a turn's tool calls with the right concurrency.
//
// Rule (ADR-008): consecutive concurrency-safe (read-only) tools run in PARALLEL; anything not safe
// (a write) runs SOLO. Parallelism is a correctness choice — independent reads can't interfere, but
// writes can race. Results are returned in the ORIGINAL order (tool_results map by id either way).

import type { ActivityEvent, ContentBlock } from '../protocol'
import type { ToolContext } from './Tool'
import { defaultRegistry, type ToolRegistry } from './toolRegistry'
import { executeTool, type ToolUse } from './runTool'
import { describeInvalidInput, normalizeInput } from './inputNormalizer'
import { checkPermission } from '../permissions/gate'
import { splitCommandSegments } from '../permissions/bashClassifier'
import { parseEscalation, SANDBOX_DENIAL_PREFIX, stripEscalationFields } from '../sandbox/escalation'
import type { SandboxPolicy } from '../sandbox/policy'
import { formatAnswers } from './builtins/AskUserQuestion'
import { runHooks } from '../hooks/hookRunner'
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

/** ADR-044: a write blocked because the session is in PLAN MODE — NOT a user decline. Tell the model plainly so
 *  it doesn't misread it as a filesystem error or retry; it should finish planning and call ExitPlanMode. */
function planDeniedBlock(id: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content:
      'You are in PLAN MODE — file writes and shell commands are blocked until the user approves your plan. ' +
      'This is not an error and retrying will not help. Keep exploring read-only (Read/Glob/Grep/Lsp), finish ' +
      'your plan, then call ExitPlanMode with it for approval.',
    isError: true,
  }
}

/** ADR-036: a tool blocked by a PROJECT HOOK — the user's own deterministic guard. The hook's stderr/reason
 *  is the model-visible explanation (hook feedback counts as the user's own word). */
function hookDeniedBlock(id: string, reason?: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content:
      `A project hook blocked this tool call: ${reason ?? 'no reason given'}. ` +
      'This is a deliberate project rule, not a transient error — do not retry the same call; adjust your approach to respect the rule.',
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
  // ADR-070 step 2: per-call sandbox grants. An APPROVED escalation widens the policy for exactly the
  // one tool-use id that asked — recorded here, consumed at execution as a per-call ctx override. Tools
  // never read the escalation fields themselves (they're stripped after approval), so no tool can widen
  // from its own arguments: the only path to a wider policy runs through this map.
  const widened = new Map<string, SandboxPolicy>()
  // ADR-082: escalation asks that were judged a NO-OP (same/narrower mode, unconfined, or no prior denial)
  // run normally with the fields stripped; the judge's note rides the tool result so the model learns the
  // rule at the decision point instead of being taught by a failed call.
  const noopNotes = new Map<string, string>()

  for (const batch of partition(toolUses, registry)) {
    // ── 1. GATE every tool first. Reads auto-allow instantly (no await); a write in 'default' mode
    //       returns 'ask', so we yield a card and PARK on perm.request() until the user clicks. ──
    const toRun: ToolUse[] = []
    for (const tu of batch) {
      const tool = registry.find(tu.name)

      // ── ADR-043/044: an INTERACTIVE tool (AskUserQuestion, ExitPlanMode) — its effect is a round-trip to the
      //    user. Mirror the permission park: yield a `question` event and BLOCK on ctx.ask.request() until
      //    respondQuestion(). `toQuestions` builds what to ask; `applyAnswers` turns the reply into the result
      //    (and may act — ExitPlanMode flips the permission mode on approval). call() is skipped. Only when a
      //    channel exists — otherwise fall through and the tool returns its no-channel error (headless). ──
      if (tool?.requiresUserInteraction?.() && ctx.ask) {
        // VALIDATE BEFORE ASKING (measured, dokar/qwen3.5-9B 2026-08-09): ExitPlanMode called with `{}`
        // sailed straight past its schema — validation lived only on the call() path, which interactive
        // tools skip — so the user was shown an approval dialog with NO plan in it ("I cannot see any
        // plan"), and the model, told only "not approved", repeated the identical empty call. A malformed
        // interactive call is a MODEL error to bounce immediately, never a question to put to the user.
        // Same normalize-then-describe pipeline as executeTool, so key-alias tolerance is identical.
        // (An interactive tool without a Zod schema — the MCP case — forwards raw input, as before.)
        let interactiveInput = tu.input as never
        if (tool.inputSchema) {
          let parsed = tool.inputSchema.safeParse(tu.input)
          if (!parsed.success) {
            const normalized = normalizeInput(tu.input, tool.inputSchema)
            if (normalized) parsed = tool.inputSchema.safeParse(normalized)
          }
          if (!parsed.success) {
            const msg = describeInvalidInput(tu.name, tu.input, tool.inputSchema, parsed.error.message)
            byId.set(tu.id, { type: 'tool_result', tool_use_id: tu.id, content: msg, isError: true })
            tracer.event({ t: 'tool_call', id: tu.id, name: tu.name, input: tu.input })
            tracer.event({ t: 'tool_result', id: tu.id, name: tu.name, ok: false, ms: 0, content: msg })
            yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
            yield { type: 'toolResult', id: tu.id, ok: false, preview: msg.slice(0, 200) }
            continue
          }
          interactiveInput = parsed.data as never
        }
        const questions = tool.toQuestions?.(interactiveInput) ?? []
        // RACE FIX (measured, builder-graduate on gpt-5.6-luna hung on ExitPlanMode): register the answer
        // resolver BEFORE yielding the question. ctx.ask.request() runs its Promise executor synchronously
        // (pendingAnswers.set), so calling it first means a consumer that answers SYNCHRONOUSLY on receiving
        // the `question` event (the headless eval's auto-responder) finds the resolver already there. Yield
        // then await the SAME promise. (Yielding first, then requesting, dropped the answer → hang forever —
        // the web UI never hit it because a human answers async, after request() had registered.)
        const answered = ctx.ask.request(tu.id)
        // FORENSICS: question-path tools were invisible in traces (measured: the Simmer routing question
        // never appeared) — record the call like any other tool before parking on the user.
        tracer.event({ t: 'tool_call', id: tu.id, name: tu.name, input: tu.input })
        yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
        yield { type: 'question', id: tu.id, questions }
        const answers = await answered // ← BLOCKS until respondQuestion(tu.id, answers)
        const result = tool.applyAnswers ? await tool.applyAnswers(interactiveInput, answers, ctx) : { content: formatAnswers(answers) }
        byId.set(tu.id, { type: 'tool_result', tool_use_id: tu.id, content: result.content, isError: result.isError })
        tracer.event({ t: 'tool_result', id: tu.id, name: tu.name, ok: !result.isError, ms: 0, content: result.content })
        yield { type: 'toolResult', id: tu.id, ok: !result.isError, preview: result.content.slice(0, 200) }
        continue
      }

      // ── ADR-070 step 2: sandbox ESCALATION — judged before the normal gate. A malformed or
      //    non-widening ask is a MODEL error bounced immediately (it never reaches a human, same
      //    principle as the interactive-tool validation above). A valid ask parks on the SAME
      //    permission channel as any write; approval widens the policy for THIS call only, and the
      //    consumed fields are stripped so the tool executes a clean input. Fail-closed: no approval
      //    channel ⇒ no widening, ever. `allow-always` is deliberately treated as allow-ONCE here —
      //    a standing "always widen the sandbox" rule must never be learnable from one prompt. ──
      const esc = parseEscalation(tu.input, ctx.sandboxPolicy, { denialSeen: ctx.sandboxDenialSeen })
      if (esc && 'noop' in esc) {
        // Not an escalation this session can honor — strip the consumed fields and let the call proceed
        // under the CURRENT policy through the normal gate below (ADR-082: a no-op, never a failure).
        tu.input = stripEscalationFields(tu.input)
        noopNotes.set(tu.id, esc.noop)
      } else if (esc) {
        const fail = (content: string) => {
          byId.set(tu.id, { type: 'tool_result', tool_use_id: tu.id, content, isError: true })
          tracer.event({ t: 'tool_result', id: tu.id, name: tu.name, ok: false, ms: 0, content })
        }
        if ('error' in esc) {
          fail(esc.error)
          yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
          yield { type: 'toolResult', id: tu.id, ok: false, preview: esc.error.slice(0, 200) }
          continue
        }
        if (!perm) {
          const msg = `sandbox escalation to "${esc.ask.mode}" requires approval, but no approval channel is composed`
          fail(msg)
          yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
          yield { type: 'toolResult', id: tu.id, ok: false, preview: msg.slice(0, 200) }
          continue
        }
        yield { type: 'permission', id: tu.id, tool: tu.name, detail: `Escalate sandbox to ${esc.ask.mode}: ${esc.ask.justification}` }
        const answer = await perm.request(tu.id) // ← BLOCKS until respondPermission(tu.id, …)
        tracer.event({ t: 'permission', id: tu.id, tool: tu.name, decision: answer === 'deny' ? 'deny' : 'allow', asked: true })
        if (answer === 'deny') {
          const msg =
            `The user rejected escalating this call to "${esc.ask.mode}" — a deliberate choice, not an error. ` +
            'Do not retry the escalation; continue within the current file policy or ask the user how to proceed.'
          fail(msg)
          yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
          yield { type: 'toolResult', id: tu.id, ok: false, preview: 'Escalation rejected' }
          continue
        }
        widened.set(tu.id, { ...ctx.sandboxPolicy!, mode: esc.ask.mode })
        tu.input = stripEscalationFields(tu.input) // consumed — the tool sees a clean input
      }

      let decision = tool && perm ? checkPermission(tool, tu.input, perm.state) : 'allow'

      // ── ADR-036: PreToolUse hooks — the USER's deterministic guards, run after the rule check and
      //    before the prompt. deny → blocked with the hook's reason (model-visible);
      //    allow → skip the ask; ask → force the prompt. Hook errors are fail-open (no opinion). ──
      if (ctx.hooks && decision !== 'deny') {
        const t0 = Date.now()
        const hook = await runHooks({ event: 'PreToolUse', config: ctx.hooks, cwd: ctx.cwd, toolName: tu.name, toolInput: tu.input })
        if (hook.decision) {
          tracer.event({ t: 'hook', event: 'PreToolUse', id: tu.id, tool: tu.name, decision: hook.decision, ms: Date.now() - t0 })
          if (hook.decision === 'deny') {
            byId.set(tu.id, hookDeniedBlock(tu.id, hook.reason))
            yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
            yield { type: 'toolResult', id: tu.id, ok: false, preview: 'Blocked by hook' }
            continue
          }
          decision = hook.decision // 'allow' skips the ask; 'ask' forces it
        }
      }

      const asked = decision === 'ask' // distinguishes a real prompt from an auto-allow in the trace
      if (decision === 'ask' && perm) {
        yield { type: 'permission', id: tu.id, tool: tu.name, detail: summary(tu, registry) }
        const answer = await perm.request(tu.id) // ← BLOCKS here until respondPermission(tu.id, …)
        if (answer === 'allow-always') {
          // ADR-035: for Bash, learn EXACT-SEGMENT rules — repeat commands stop asking, variants still ask.
          // Blanket `Bash` allow-always was the over-permissioning story (npm test approved => rm -rf rides free).
          if (tu.name === 'Bash' && typeof (tu.input as { command?: string })?.command === 'string') {
            for (const seg of splitCommandSegments((tu.input as { command: string }).command)) perm.state.allow.add(`Bash(${seg})`)
          } else {
            perm.state.allow.add(tu.name) // remember for the rest of the session
          }
        }
        decision = answer === 'deny' ? 'deny' : 'allow'
      }
      tracer.event({ t: 'permission', id: tu.id, tool: tu.name, decision, asked }) // forensics: every gate verdict
      if (decision === 'deny') {
        // A write blocked BY PLAN MODE gets a plan-specific message (not the "user declined" one).
        const inPlan = perm?.state.mode === 'plan' && !(tool?.isReadOnly?.(tu.input as never) ?? false)
        byId.set(tu.id, inPlan ? planDeniedBlock(tu.id) : deniedBlock(tu.id))
        yield { type: 'toolStart', id: tu.id, name: tu.name, summary: summary(tu, registry) }
        yield { type: 'toolResult', id: tu.id, ok: false, preview: inPlan ? 'Blocked (plan mode)' : 'Denied' }
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
      tracer.event({ t: 'tool_call', id: tu.id, name: tu.name, input: tu.input, ...(tu.repaired ? { repaired: true } : {}) }) // full input, untruncated
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
      // ADR-070: an approved escalation executes under a per-call WIDENED ctx — the only widening path.
      const callCtx = widened.has(tu.id) ? { ...ctx, sandboxPolicy: widened.get(tu.id) } : ctx
      executeTool(tu, callCtx, (chunk) => (queue.push({ id: tu.id, chunk }), bump())).then((block) => {
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
      let block = settled.get(tu.id)!
      // ADR-082: a REAL denial happened — from here on a strictly wider ask may reach the user. Recorded on
      // the session ctx (not the per-call copy) so it persists across this session's steps.
      if (block.type === 'tool_result' && block.content.includes(SANDBOX_DENIAL_PREFIX)) ctx.sandboxDenialSeen = true
      // …and a judged no-op ask gets its teaching note appended, so the model stops sending the fields.
      const noop = noopNotes.get(tu.id)
      if (noop && block.type === 'tool_result') {
        block = { ...block, content: `${block.content}\n[sandbox: ${noop}]` }
        settled.set(tu.id, block)
      }
      // ── ADR-036: PostToolUse hooks — the feedback channel. A hook exiting 2 gets its stderr APPENDED to
      //    the tool_result so THE MODEL sees it (e.g. a lint hook making the model fix its own edit). ──
      if (ctx.hooks && block.type === 'tool_result') {
        const t0 = Date.now()
        const hook = await runHooks({ event: 'PostToolUse', config: ctx.hooks, cwd: ctx.cwd, toolName: tu.name, toolInput: tu.input, toolResponse: block.content })
        if (hook.feedback.length > 0) {
          tracer.event({ t: 'hook', event: 'PostToolUse', id: tu.id, tool: tu.name, decision: 'feedback', ms: Date.now() - t0 })
          block = { ...block, content: `${block.content}\n\n[Project hook feedback — address this]: ${hook.feedback.join('\n')}` }
          settled.set(tu.id, block)
        }
      }
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
