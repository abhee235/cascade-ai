// core/protocol.ts — the message model + the WIRE protocol.
//
// Everything that crosses a boundary (webview postMessage, or WebSocket to the web app)
// is one of these types. They are plain JSON-serializable objects on purpose: that is what
// makes the in-process (extension) and remote (web) frontends interchangeable. — ADR-018.


// ── Internal message model (typed content blocks) ───────────────────────────────────────
// Grows in Phase 3+. In Phase 0 only `text` is exercised.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; isError?: boolean }

export type Message =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }

// ── Activity events: core → frontend ────────────────────────────────────────────────────
// The frontend renders these. Note `message` carries the FINAL answer, rendered whole
// (activity-first UI, no prose streaming — ADR-013). More variants arrive in later phases.
export type ActivityEvent =
  | { type: 'status'; text: string } // "Thinking…", and tool-step activity in later phases
  | { type: 'thinking_delta'; thinking: string } // a chunk of reasoning, streamed live (ADR-013)
  | { type: 'text_delta'; text: string } // a chunk of the answer, streamed live (ADR-013)
  | { type: 'toolStart'; id: string; name: string; summary: string } // a tool is about to run (Phase 4)
  | { type: 'permission'; id: string; tool: string; detail: string } // a write needs approval; loop BLOCKS until respondPermission (Phase 7)
  | { type: 'toolProgress'; id: string; chunk: string } // live output from a running tool, e.g. Bash stdout (Phase 8)
  | { type: 'toolResult'; id: string; ok: boolean; preview: string } // a tool finished (Phase 4)
  | { type: 'message'; message: Message } // the finalized answer (authoritative; UI commits it)
  | { type: 'turnDone'; steps: number }

// ── Inbound messages: frontend → core ───────────────────────────────────────────────────
export type InboundMessage =
  | { type: 'submit'; text: string }
  | { type: 'permission'; id: string; decision: 'allow' | 'allow-always' | 'deny' }
  | { type: 'abort' }
  | { type: 'reset' } // "New chat" — clears conversation history
