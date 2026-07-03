// agent/agentLoop.ts — THE agentic loop.
//
// "Agentic" = a while-loop around a stateless model:
//   stream the model → collect any tool_use blocks → if NONE, that's the final answer (terminal);
//   else run the tools, append their tool_results, and loop so the next call sees them.
// Tool use is detected by PRESENCE of tool_use blocks, not by stop_reason (stop_reason is
// unreliable). The recurse is the agent.

import type { ActivityEvent, ContentBlock, Message } from '../protocol'
import type { ModelProvider } from '../llm/provider'
import type { ToolContext } from '../tools/Tool'
import type { PermissionController } from '../permissions/gate'
import { NoopTracer, type Tracer } from '../observability/tracer'
import { createRegistry, registryOf, type ToolRegistry } from '../tools/toolRegistry'
import { buildSystemPrompt } from './systemPrompt'
import { compactIfNeeded, estimateTokens, type CompactDeps } from '../context/compactor'
import { streamWithRecovery, type RecoveryOptions } from '../llm/resilience'
import type { ToolUse } from '../tools/runTool'
import { scheduleTools } from '../tools/scheduler'
import { buildTodoReminder, shouldRemindTodos, type TodoReminderConfig } from './todoReminder'
import { buildVerifyNudge, foldVerifyState } from './verifyGate'
import { buildDelegateNudgeText, foldReadPressure, READ_PRESSURE_FRACTION, sawSubagent } from './delegateNudge'

export interface LoopDeps {
  provider: ModelProvider
  model: string
  cwd: string
  signal: AbortSignal
  maxTurns?: number
  permission?: PermissionController // Phase 7: gates tool calls; how 'ask' awaits the user
  tracer?: Tracer // ADR-023: forensic JSONL trace
  registry?: ToolRegistry // Phase 9: builtins + ready MCP tools; defaults to builtins-only
  archival?: import('../memory/archival').ArchivalMemory // Phase 10: semantic memory the tools can use
  recalled?: string // Phase 10: archival memories auto-retrieved for this turn (proactive retrieval)
  extraInstructions?: string // Phase 15: generic extra system-prompt context (e.g. a template's AI rules)
  projectContext?: string // ADR-046: gathered project facts (dir tree + git status), main-agent only
  compact?: CompactDeps // Phase 11: compact the history when it nears the window
  depth?: number // Phase 12: subagent nesting depth (0 = main agent)
  recovery?: Pick<RecoveryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'> // Phase 12: tune/inject for tests
  sandbox?: import('../sandbox/sandbox').Sandbox // Phase 13.3: redirect command tools here (injected by the server)
  readFileState?: import('../tools/fileState').FileStateCache // ADR-032: read-before-edit freshness cache (session-scoped)
  todoStore?: import('../tools/todoStore').TodoStore // ADR-034: authoritative todo checklist (drives the reminder)
  todoReminder?: TodoReminderConfig // ADR-034: tune/inject the reminder turn thresholds (default 6/6)
  ask?: import('../tools/Tool').AskController // ADR-043: AskUserQuestion round-trip channel (main agent only)
  /** ADR-049: refuse a terminal answer when files were edited but nothing verified them (one nudge turn,
   *  then accept). Default ON — it only ever fires when unverified edits exist. Set false to opt out. */
  verifyGate?: boolean
  /** ADR-050 rung 2: when bulk reads have eaten a large share of the window and no delegation happened,
   *  remind the model ONCE to send explore subagents instead. Default ON; needs a known window (compact
   *  deps) and the Subagent tool in the registry, so children/chat-only sessions never see it. */
  delegateNudge?: boolean
  /** ADR-037: window tier sizing the system prompt + tool descriptions. Defaults to the compaction plan's tier
   *  (one source of truth); set explicitly for loops without compaction (e.g. subagents inherit the parent's). */
  tier?: import('../llm/contextWindows').WindowTier
}

const MAX_SUBAGENT_DEPTH = 2
const READONLY_SUBAGENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'MemorySearch'])

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
}

// Append a reminder (<system-reminder> text) as a block on the trailing user message (ADR-034/049/050 share this). The leading blank line separates it
// from any preceding text (e.g. the initial user input); when the trailing message is a tool_results message,
// the reminder is its only text block, which the OpenAI converter emits as a clean user turn after the tools.
function appendReminder(messages: Message[], reminder: string): void {
  const last = messages[messages.length - 1]
  const text = `\n\n${reminder}`
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: text })
    return
  }
  const blocks: ContentBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content]
  blocks.push({ type: 'text', text })
  messages[messages.length - 1] = { ...last, content: blocks }
}

export async function* runAgentLoop(messages: Message[], deps: LoopDeps): AsyncIterable<ActivityEvent> {
  const tracer = deps.tracer ?? NoopTracer
  const registry = deps.registry ?? createRegistry()
  // Share ONE registry instance for the turn: the loop advertises with it, and the scheduler/runTool look
  // up with it — so what the model is offered and what we execute always agree.
  const depth = deps.depth ?? 0
  // ADR-037: one window tier for the whole loop — sizes the system prompt AND the tool descriptions. Explicit
  // deps.tier (subagents inherit the parent's) → the compaction plan's tier → 'full'.
  const tier = deps.tier ?? deps.compact?.plan.tier ?? 'full'
  const ctx: ToolContext = { cwd: deps.cwd, abortSignal: deps.signal, permission: deps.permission, tracer, registry, archival: deps.archival, depth, sandbox: deps.sandbox, readFileState: deps.readFileState, todoStore: deps.todoStore, ask: deps.ask }
  // Subagent delegation (ADR-017): inject a spawn closure (avoids an import cycle). Absent at the depth cap.
  // The child runs a NESTED runAgentLoop with its OWN messages + a filtered tool set (never Subagent → no
  // recursion; read-only subset for `explore`). Only its final text returns — its steps stay in its context.
  if (depth < MAX_SUBAGENT_DEPTH) {
    ctx.spawnSubagent = async ({ prompt, readOnly }) => {
      const childRegistry = registryOf(() =>
        registry.list().filter((t) => t.name !== 'Subagent' && (!readOnly || READONLY_SUBAGENT_TOOLS.has(t.name))),
      )
      let finalText = ''
      for await (const ev of runAgentLoop([{ role: 'user', content: prompt }], {
        provider: deps.provider,
        model: deps.model,
        cwd: deps.cwd,
        signal: deps.signal,
        registry: childRegistry,
        tracer,
        permission: deps.permission,
        sandbox: deps.sandbox, // subagent's commands run in the same sandbox
        readFileState: deps.readFileState, // share freshness cache: a file the parent read is editable by the child
        todoStore: deps.todoStore, // shared store, keyed by depth → the child's checklist is scoped separately
        todoReminder: deps.todoReminder,
        tier, // child loops have no compact deps — inherit the parent's window tier (same model, same window)
        maxTurns: 8,
        depth: depth + 1,
      })) {
        if (ev.type === 'message') {
          const t = messageText(ev.message)
          if (t) finalText = t // last assistant message wins (the subagent's conclusion)
        }
      }
      return finalText || '(subagent produced no output)'
    }
  }
  const maxTurns = deps.maxTurns ?? 10
  let turn = 0
  // ADR-049 verification gate: `editedSinceVerify` = a file-mutating tool succeeded and no test command has
  // run since. At the terminal branch we nudge ONCE per submit, then accept the next answer unconditionally.
  let editedSinceVerify = false
  let verifyNudged = false
  // ADR-050 delegation nudge: cumulative bulk-read result tokens this submit; fires once when they cross
  // READ_PRESSURE_FRACTION of the window without any Subagent use. Window comes from the compaction plan.
  let readPressureTokens = 0
  let delegateNudged = false
  let subagentUsed = false

  while (true) {
    let text = ''
    let thinking = ''
    let usage: import('../llm/provider').TokenUsage | undefined // E1/ADR-040: backend token counts for this call
    const toolUses: ToolUse[] = []

    // Compaction (ADR-012): BEFORE each model call, if history nears the window, mask old tool output and/or
    // summarize the older half. We splice in place so the session's history reference stays valid; the raw
    // transcript + JSONL trace are untouched (you'll see the next model_request shrink).
    if (deps.compact) {
      const tokensBefore = estimateTokens(messages)
      const { messages: compacted, kind } = await compactIfNeeded(messages, deps.compact)
      if (kind !== 'none') {
        messages.splice(0, messages.length, ...compacted)
        // E1/ADR-040: record which layer fired and what it reclaimed — the eval analyzer counts these to
        // diagnose context_thrash (≥3 compactions per run ⇒ thresholds/window are the knob to tweak).
        tracer.event({ t: 'compaction', kind, tokensBefore, tokensAfter: estimateTokens(messages), forced: false })
        yield { type: 'compacted', kind }
      }
    }

    // ADR-034: if the model has drifted from its task checklist (idle on TodoWrite for several turns), re-inject
    // the current list as a <system-reminder> so it re-grounds. Appended to the trailing user message (always a
    // user message here — initial input or tool_results) so the converter emits it as a user turn AFTER any
    // tool_results. NOT yielded as an activity event ⇒ it reaches the model but never the UI. Done after
    // compaction so the reminder isn't immediately summarized away (and reflects the post-compaction state).
    if (deps.todoStore) {
      const items = deps.todoStore.get(depth)
      if (shouldRemindTodos(messages, items, deps.todoReminder)) appendReminder(messages, buildTodoReminder(items))
    }

    yield { type: 'status', text: 'Thinking…' }
    // FORENSICS: record the FULL request we're about to send — the #1 thing you need when an answer
    // is wrong ("did the model even see the tool_result / the right system prompt?"). — ADR-023.
    const system = buildSystemPrompt({ cwd: deps.cwd, sandboxRoot: deps.sandbox?.root, tier, subagent: depth > 0, recalled: deps.recalled, extraInstructions: deps.extraInstructions, projectContext: deps.projectContext })
    tracer.event({ t: 'model_request', turn, system, tools: registry.list().map((t) => t.name), messages })
    // Wrap the stream in recovery (ADR-016): transient failures retry with backoff; context overflow triggers
    // a (reactive) compaction then retries; abort/fatal surface. `make` re-reads `messages` each attempt, so
    // an overflow-compaction is reflected on the retry. System is rebuilt too (memory may have changed).
    const makeStream = () =>
      deps.provider.stream({ messages, model: deps.model, system: buildSystemPrompt({ cwd: deps.cwd, sandboxRoot: deps.sandbox?.root, tier, subagent: depth > 0, recalled: deps.recalled, extraInstructions: deps.extraInstructions, projectContext: deps.projectContext }), tools: registry.schemas(tier) }, deps.signal)
    for await (const ev of streamWithRecovery(makeStream, {
      ...deps.recovery,
      signal: deps.signal,
      onOverflow: deps.compact
        ? async () => {
            // Reactive overflow: force compaction regardless of the threshold (ADR-039 `force`) — the model just
            // reported the prompt is too large, so waiting for the `auto` gate would just loop.
            const tokensBefore = estimateTokens(messages)
            const { messages: c, kind } = await compactIfNeeded(messages, deps.compact!, { force: true })
            if (kind !== 'none') {
              messages.splice(0, messages.length, ...c)
              tracer.event({ t: 'compaction', kind, tokensBefore, tokensAfter: estimateTokens(messages), forced: true })
            }
          }
        : undefined,
      onRetry: (info) => tracer.event({ t: 'error', message: `recover(${info.reason}) attempt ${info.attempt}, wait ${Math.round(info.delayMs)}ms` }),
    })) {
      if (ev.type === 'retry') {
        // A failed attempt is being retried: DISCARD any partial output from it (so we don't double-count
        // text), and surface a persistent recovery CARD so the user sees we're reconnecting, not dead.
        text = ''
        thinking = ''
        usage = undefined
        toolUses.length = 0
        yield { type: 'recovering', attempt: ev.attempt, reason: ev.reason, delayMs: ev.delayMs }
      } else if (ev.type === 'thinking_delta') {
        thinking += ev.thinking
        yield { type: 'thinking_delta', thinking: ev.thinking }
      } else if (ev.type === 'text_delta') {
        text += ev.text
        yield { type: 'text_delta', text: ev.text }
      } else if (ev.type === 'tool_use') {
        toolUses.push({ id: ev.id, name: ev.name, input: ev.input })
      } else if (ev.type === 'done' && ev.usage) {
        usage = ev.usage // backend-reported prompt/output token counts (undefined when not reported)
      }
    }

    tracer.event({ t: 'model_response', turn, text, thinking, toolUses, usage })

    // Record the assistant turn in history: thinking, text, then tool_use blocks.
    const assistant: ContentBlock[] = []
    if (thinking) assistant.push({ type: 'thinking', thinking })
    if (text) assistant.push({ type: 'text', text })
    for (const tu of toolUses) assistant.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    messages.push({ role: 'assistant', content: assistant })

    // Commit THIS turn's visible message (text + thinking, no tool_use blocks) so every step shows in
    // order: user → assistant text → tool card(s) → next assistant text. The UI commits each on `message`.
    const display: ContentBlock[] = []
    if (thinking) display.push({ type: 'thinking', thinking })
    if (text) display.push({ type: 'text', text })
    if (display.length) yield { type: 'message', message: { role: 'assistant', content: display } }

    // TERMINAL — no tool calls → done. Unless the verification gate objects (ADR-049): files were edited
    // but nothing verified them → inject ONE nudge turn and loop; the next terminal answer is accepted
    // unconditionally (the model may legitimately answer "no tests exist here").
    if (toolUses.length === 0) {
      if (deps.verifyGate !== false && editedSinceVerify && !verifyNudged && turn + 1 < maxTurns) {
        verifyNudged = true
        tracer.event({ t: 'verify_gate', turn })
        messages.push(buildVerifyNudge())
        yield { type: 'status', text: 'Asking the agent to verify its changes…' }
        turn++
        continue
      }
      if (!display.length) yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'turnDone', steps: turn }
      return
    }

    // Run the tools via the scheduler: read-only ones in parallel, writes serial (ADR-008). It yields
    // the toolStart/toolResult activity and returns the tool_result blocks in original order.
    const results = yield* scheduleTools(toolUses, ctx)
    messages.push({ role: 'user', content: results }) // tool_results become the next turn's input
    editedSinceVerify = foldVerifyState(editedSinceVerify, toolUses, results) // ADR-049 gate state

    // ADR-050 rung 2: harness-detected delegation reminder. Recognition ("I should delegate") is
    // meta-cognition weak/mid models don't do — so the LOOP watches bulk-read pressure and reminds ONCE.
    // Requires a known window (compaction plan) + the Subagent tool advertised (parent loops only —
    // children get a Subagent-less registry). Appended to the trailing tool_results message (ADR-034 style).
    readPressureTokens = foldReadPressure(readPressureTokens, toolUses, results)
    if (sawSubagent(toolUses)) subagentUsed = true
    const window = deps.compact?.plan.window
    if (
      deps.delegateNudge !== false &&
      !delegateNudged &&
      !subagentUsed &&
      window !== undefined &&
      readPressureTokens > window * READ_PRESSURE_FRACTION &&
      registry.list().some((t) => t.name === 'Subagent')
    ) {
      delegateNudged = true
      tracer.event({ t: 'delegate_nudge', turn, readTokens: readPressureTokens })
      appendReminder(messages, buildDelegateNudgeText())
      yield { type: 'status', text: 'Suggesting delegation for the remaining reads…' }
    }

    if (++turn >= maxTurns) {
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'status', text: `Stopped after ${maxTurns} turns.` }
      yield { type: 'turnDone', steps: turn }
      return
    }
    // loop → the next model call sees the tool results
  }
}
