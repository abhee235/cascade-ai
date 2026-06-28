import type { Message, ToolDisplay } from '@cascade/core'

/** One rendered row in the chat transcript. The agent-action cards (kind:'tool') are dispatched by name. */
export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; thinking?: string; thoughtMs?: number }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; preview?: string; display?: ToolDisplay }
  | { kind: 'memory'; text: string }
  | { kind: 'compacted'; text: string }

export type Streaming = { text: string; thinking: string }
export type Recovering = { attempt: number; reason: string }
export type RightTab = 'preview' | 'code' | 'versions' // top builder pane (Console moved to the bottom panel)
export type BottomTab = 'terminal' | 'problems' | 'output' | 'ports' // VS Code-style bottom panel (M7)
export type Page = 'home' | 'project' | 'projects' | 'chats' | 'settings'
export type PreviewState = { status: 'installing' | 'starting' | 'running' | 'error' | 'stopped'; url?: string }
// A build/runtime error captured from the running preview (Vite overlay or window.onerror), via postMessage.
export type RuntimeError = { kind: 'build' | 'runtime'; message: string; file?: string; line?: number; col?: number }

/** Split a core Message into rendered text + collapsible thinking. */
export function extractMessage(m: Message): { text: string; thinking: string } {
  if (typeof m.content === 'string') return { text: m.content, thinking: '' }
  let text = ''
  let thinking = ''
  for (const b of m.content) {
    if (b.type === 'text') text += b.text
    else if (b.type === 'thinking') thinking += b.thinking
  }
  return { text, thinking }
}
