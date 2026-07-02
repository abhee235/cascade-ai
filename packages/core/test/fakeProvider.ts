// FakeLLM — a ModelProvider that replays SCRIPTED StreamEvents, one script per stream() call.
// This is what makes the engine testable without Ollama: deterministic, instant, offline.
//
// Usage: each element of `turns` is the event list for one model call (one loop turn). The agent loop
// calls stream() once per turn, so script per turn. Each script should end with a `done` event.

import type { CompletionRequest, CompletionResult, ModelProvider, StreamEvent, TokenUsage } from '../src/llm/provider'

export type Turn = StreamEvent[]

export interface FakeProvider extends ModelProvider {
  /** Requests captured per call — assert what the loop sent (messages, tools, system). */
  readonly calls: CompletionRequest[]
}

export function createFakeProvider(turns: Turn[]): FakeProvider {
  let i = 0
  const calls: CompletionRequest[] = []
  return {
    id: 'fake',
    calls,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      calls.push(req)
      const text = (turns[i++] ?? []).filter((e) => e.type === 'text_delta').map((e) => (e as any).text).join('')
      return { text }
    },
    async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
      calls.push(req)
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
      for (const ev of turn) yield ev
    },
  }
}

// Small builders to keep test scripts readable.
export const textDelta = (text: string): StreamEvent => ({ type: 'text_delta', text })
export const toolUse = (id: string, name: string, input: unknown): StreamEvent => ({ type: 'tool_use', id, name, input })
export const done = (stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn', usage?: TokenUsage): StreamEvent => ({ type: 'done', stopReason, usage })
