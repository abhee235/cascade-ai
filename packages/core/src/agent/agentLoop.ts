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
import { buildSystemPrompt } from './systemPrompt'
import { findTool, toolSchemas } from '../tools/toolRegistry'
import { executeTool, type ToolUse } from '../tools/runTool'

export interface LoopDeps {
  provider: ModelProvider
  model: string
  cwd: string
  signal: AbortSignal
  maxTurns?: number
}

function safeSummary(tu: ToolUse): string {
  try {
    return findTool(tu.name)?.activitySummary(tu.input as never) ?? tu.name
  } catch {
    return tu.name
  }
}

export async function* runAgentLoop(messages: Message[], deps: LoopDeps): AsyncIterable<ActivityEvent> {
  const ctx: ToolContext = { cwd: deps.cwd, abortSignal: deps.signal }
  const maxTurns = deps.maxTurns ?? 10
  let turn = 0

  while (true) {
    let text = ''
    let thinking = ''
    const toolUses: ToolUse[] = []

    yield { type: 'status', text: 'Thinking…' }
    for await (const ev of deps.provider.stream(
      { messages, model: deps.model, system: buildSystemPrompt({ cwd: deps.cwd }), tools: toolSchemas() },
      deps.signal,
    )) {
      if (ev.type === 'thinking_delta') {
        thinking += ev.thinking
        yield { type: 'thinking_delta', thinking: ev.thinking }
      } else if (ev.type === 'text_delta') {
        text += ev.text
        yield { type: 'text_delta', text: ev.text }
      } else if (ev.type === 'tool_use') {
        toolUses.push({ id: ev.id, name: ev.name, input: ev.input })
      }
    }

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
      yield { type: 'turnDone', steps: turn }
      return
    }

    // Run each tool, surface activity, collect tool_result blocks.
    const results: ContentBlock[] = []
    for (const tu of toolUses) {
      yield { type: 'toolStart', id: tu.id, name: tu.name, summary: safeSummary(tu) }
      const block = await executeTool(tu, ctx)
      results.push(block)
      const isError = block.type === 'tool_result' && !!block.isError
      const preview = block.type === 'tool_result' ? block.content.slice(0, 200) : ''
      yield { type: 'toolResult', id: tu.id, ok: !isError, preview }
    }
    messages.push({ role: 'user', content: results }) // tool_results become the next turn's input

    if (++turn >= maxTurns) {
      yield { type: 'status', text: `Stopped after ${maxTurns} turns.` }
      yield { type: 'turnDone', steps: turn }
      return
    }
    // loop → the next model call sees the tool results
  }
}
