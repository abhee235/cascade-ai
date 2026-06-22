# ADR-004 — Streaming as a typed internal event generator

**Status:** Accepted (Phase 2)

## Context
With `stream: true`, an OpenAI-compatible endpoint returns Server-Sent-Event lines (`data: {...}\n`),
each carrying a small `delta`. We need to consume these incrementally without coupling the rest of the
app to the wire format.

## Decision
The provider's `stream()` is an **async generator** that yields a typed `StreamEvent` union
(`text_delta` | `thinking_delta` | `done`), defined in `llm/provider.ts`.

- **Parsing** (in `OpenAICompatProvider`): read the response body with a reader; **buffer the partial
  trailing line** across chunks (a JSON object can split mid-line); split on `\n`; for each `data:`
  line, `JSON.parse` and map `delta.content` → `text_delta`, `delta.reasoning` → `thinking_delta`;
  skip `[DONE]` and unparyable keepalives; `finish_reason: "length"` → `stopReason: "max_tokens"`.
- **Placement**: `StreamEvent` lives with the provider, **not** in `core/protocol.ts`. It is an
  internal llm↔session type and deliberately never crosses to the frontend (see ADR-013).

## Consequences
- The session consumes one clean async iterable; it never touches SSE framing.
- Adding a non-OpenAI provider means implementing the same `stream()` shape with that vendor's
  framing — the session is unaffected.
- The generator is the seam Phase 4 extends with `tool_use_start` / `tool_use_delta` / `block_stop`
  for streamed tool calls.

## Pitfalls captured
- **Never `JSON.parse` a delta line without buffering** — partial lines across network chunks are
  normal and would throw. We keep `lines.pop()` as the carry-over buffer.
- Order matters: thinking deltas arrive before content deltas for reasoning models.

## Prior art
The common shape: a streaming loop over SSE events that accumulates content blocks, including the
partial tool-call JSON. Proxies that bridge Ollama to a content-block API do the same
`delta.content`/`delta.reasoning` → block mapping used here.
