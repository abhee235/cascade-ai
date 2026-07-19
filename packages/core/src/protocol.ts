// core/protocol.ts — the message model + the WIRE protocol.
//
// Everything that crosses a boundary (webview postMessage, or WebSocket to the web app)
// is one of these types. They are plain JSON-serializable objects on purpose: that is what
// makes the in-process (extension) and remote (web) frontends interchangeable. — ADR-018.


// ── Internal message model (typed content blocks) ───────────────────────────────────────
// Grows in Phase 3+. In Phase 0 only `text` is exercised.
// A generic UI rendering hint a tool can attach to its result (M2). The engine just passes it through; the
// FRONTEND interprets it (e.g. a file-edit shows a diff card instead of a plain output preview).
/** One task in the agent's session checklist (TodoWrite). `content` is imperative ("Run tests"); `activeForm`
 *  is the present-continuous shown while in_progress ("Running tests"). */
export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

/** A generic UI rendering hint a tool may attach to its result; the engine passes it through untouched and the
 *  frontend interprets it (ADR-028). The model never sees it. */
export type ToolDisplay =
  | { kind: 'fileEdit'; path: string; op: 'create' | 'edit' | 'overwrite'; diff: string }
  | { kind: 'todos'; items: TodoItem[] } // the current task checklist (TodoWrite) — frontend renders it

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; url: string } // a data URI (data:image/png;base64,…) attached to a user turn (M11)
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; isError?: boolean; display?: ToolDisplay }

export type Message =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }

// ── AskUserQuestion (ADR-043): a structured multiple-choice question the agent asks mid-task. ──
export interface QuestionOption {
  label: string
  description: string
  preview?: string // optional artifact (mockup/code) for visual comparison; single-select only
}
export interface Question {
  question: string
  header: string // short chip label (≤12 chars), e.g. "Auth method"
  options: QuestionOption[] // 2–4 distinct choices; the UI always adds an "Other" free-text option
  multiSelect: boolean
}
/** The user's answers, keyed by question text → the chosen label(s) (multi-select: comma-joined). */
export type Answers = Record<string, string>

// ── Activity events: core → frontend ────────────────────────────────────────────────────
// The frontend renders these. Note `message` carries the FINAL answer, rendered whole
// (activity-first UI, no prose streaming — ADR-013). More variants arrive in later phases.
export type ActivityEvent =
  | { type: 'status'; text: string } // "Thinking…", and tool-step activity in later phases
  | { type: 'thinking_delta'; thinking: string } // a chunk of reasoning, streamed live (ADR-013)
  | { type: 'text_delta'; text: string } // a chunk of the answer, streamed live (ADR-013)
  | { type: 'toolStart'; id: string; name: string; summary: string } // a tool is about to run (Phase 4)
  | { type: 'permission'; id: string; tool: string; detail: string } // a write needs approval; loop BLOCKS until respondPermission (Phase 7)
  | { type: 'question'; id: string; questions: Question[] } // ADR-043: the agent asks the user; loop BLOCKS until respondQuestion
  | { type: 'toolProgress'; id: string; chunk: string } // live output from a running tool, e.g. Bash stdout (Phase 8)
  | { type: 'toolResult'; id: string; ok: boolean; preview: string; display?: ToolDisplay } // a tool finished (Phase 4; M2 display hint)
  | { type: 'message'; message: Message } // the finalized answer (authoritative; UI commits it)
  | { type: 'turnDone'; steps: number } // the ONLY "we are finished" signal — everything else means still working
  | { type: 'step'; n: number } // a model step is STARTING (prefill begins — the dead-air phase). UIs use it to show "reading input…" until the first delta; it must never clear the working state (only turnDone does)
  | { type: 'memory'; scope: string; text: string } // Phase 10: a fact auto-saved by self-curation (UI marker)
  | { type: 'compacted'; kind: string } // Phase 11: context was compacted ('masked' | 'summarized')
  | { type: 'recovering'; attempt: number; reason: string; delayMs: number } // Phase 12: retrying a failed model call (UI card)
  | { type: 'mcpStatus'; servers: { name: string; status: string; error?: string; toolNames: string[] }[] } // Phase 9: /mcp panel
  | { type: 'memoryData'; core: string; archival: { id: string; text: string; ts: string }[]; hits?: { text: string; score: number }[] } // Phase 10: /memory panel

// ── Inbound messages: frontend → core ───────────────────────────────────────────────────
export type InboundMessage =
  | { type: 'submit'; text: string; images?: string[] } // images: data URIs for a multimodal turn (M11)
  | { type: 'permission'; id: string; decision: 'allow' | 'allow-always' | 'deny' }
  | { type: 'answer'; id: string; answers: Answers } // ADR-043: the user's response to a `question` event
  | { type: 'abort' }
  | { type: 'reset' } // "New chat" — clears conversation history
  | { type: 'mcp'; action: 'list' | 'connect' | 'disconnect'; server?: string } // Phase 9: /mcp panel controls
  | { type: 'memoryView'; action: 'list' | 'search' | 'forget'; query?: string; id?: string } // Phase 10: /memory panel controls
