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
import { compactIfNeeded, type CompactDeps } from '../context/compactor'
import { streamWithRecovery, type RecoveryOptions } from '../llm/resilience'
import type { ToolUse } from '../tools/runTool'
import { scheduleTools } from '../tools/scheduler'

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
  compact?: CompactDeps // Phase 11: compact the history when it nears the window
  depth?: number // Phase 12: subagent nesting depth (0 = main agent)
  recovery?: Pick<RecoveryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'> // Phase 12: tune/inject for tests
}

const MAX_SUBAGENT_DEPTH = 2
const READONLY_SUBAGENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'MemorySearch'])

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
}

export async function* runAgentLoop(messages: Message[], deps: LoopDeps): AsyncIterable<ActivityEvent> {
  const tracer = deps.tracer ?? NoopTracer
  const registry = deps.registry ?? createRegistry()
  // Share ONE registry instance for the turn: the loop advertises with it, and the scheduler/runTool look
  // up with it — so what the model is offered and what we execute always agree.
  const depth = deps.depth ?? 0
  const ctx: ToolContext = { cwd: deps.cwd, abortSignal: deps.signal, permission: deps.permission, tracer, registry, archival: deps.archival, depth }
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

  while (true) {
    let text = ''
    let thinking = ''
    const toolUses: ToolUse[] = []

    // Compaction (ADR-012): BEFORE each model call, if history nears the window, mask old tool output and/or
    // summarize the older half. We splice in place so the session's history reference stays valid; the raw
    // transcript + JSONL trace are untouched (you'll see the next model_request shrink).
    if (deps.compact) {
      const { messages: compacted, kind } = await compactIfNeeded(messages, deps.compact)
      if (kind !== 'none') {
        messages.splice(0, messages.length, ...compacted)
        yield { type: 'compacted', kind }
      }
    }

    yield { type: 'status', text: 'Thinking…' }
    // FORENSICS: record the FULL request we're about to send — the #1 thing you need when an answer
    // is wrong ("did the model even see the tool_result / the right system prompt?"). — ADR-023.
    const system = buildSystemPrompt({ cwd: deps.cwd, recalled: deps.recalled })
    tracer.event({ t: 'model_request', turn, system, tools: registry.list().map((t) => t.name), messages })
    // Wrap the stream in recovery (ADR-016): transient failures retry with backoff; context overflow triggers
    // a (reactive) compaction then retries; abort/fatal surface. `make` re-reads `messages` each attempt, so
    // an overflow-compaction is reflected on the retry. System is rebuilt too (memory may have changed).
    const makeStream = () =>
      deps.provider.stream({ messages, model: deps.model, system: buildSystemPrompt({ cwd: deps.cwd, recalled: deps.recalled }), tools: registry.schemas() }, deps.signal)
    for await (const ev of streamWithRecovery(makeStream, {
      ...deps.recovery,
      signal: deps.signal,
      onOverflow: deps.compact
        ? async () => {
            const { messages: c, kind } = await compactIfNeeded(messages, { ...deps.compact!, config: { ...deps.compact!.config, compactRatio: 0.6 } })
            if (kind !== 'none') messages.splice(0, messages.length, ...c)
          }
        : undefined,
      onRetry: (info) => tracer.event({ t: 'error', message: `recover(${info.reason}) attempt ${info.attempt}, wait ${Math.round(info.delayMs)}ms` }),
    })) {
      if (ev.type === 'retry') {
        // A failed attempt is being retried: DISCARD any partial output from it (so we don't double-count
        // text), and surface a persistent recovery CARD so the user sees we're reconnecting, not dead.
        text = ''
        thinking = ''
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
      }
    }

    tracer.event({ t: 'model_response', turn, text, thinking, toolUses })

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

    // TERMINAL — no tool calls → done.
    if (toolUses.length === 0) {
      if (!display.length) yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'turnDone', steps: turn }
      return
    }

    // Run the tools via the scheduler: read-only ones in parallel, writes serial (ADR-008). It yields
    // the toolStart/toolResult activity and returns the tool_result blocks in original order.
    const results = yield* scheduleTools(toolUses, ctx)
    messages.push({ role: 'user', content: results }) // tool_results become the next turn's input

    if (++turn >= maxTurns) {
      tracer.event({ t: 'turn_done', turns: turn })
      yield { type: 'status', text: `Stopped after ${maxTurns} turns.` }
      yield { type: 'turnDone', steps: turn }
      return
    }
    // loop → the next model call sees the tool results
  }
}
