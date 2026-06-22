# ADR-003 — Content-block internal message model; translate at the LLM boundary

**Status:** Accepted (Phases 2–3)

## Context
Different providers represent messages differently (OpenAI roles+`tool_calls`; other vendors use typed
content blocks `text`/`thinking`/`tool_use`/`tool_result`). If the agent core spoke one provider's wire format,
swapping providers or adding tools later would ripple through everything.

## Decision
Cascade uses **one internal, provider-neutral message model** — typed **content blocks**
(`core/protocol.ts`: `ContentBlock` = `text`/`thinking`/`tool_use`/`tool_result`, `Message` =
user/assistant). Everything above the LLM client uses this model. **Translation to/from a provider's
wire format happens ONLY inside `llm/providers/*`** (`toOpenAIMessages`), and the system prompt is
prepended there as a `{role:'system'}` message.

History (Phase 3) is a `Message[]` kept in the session; assistant turns are stored as text blocks
(thinking is display-only and not resent).

## Consequences
- The loop, session, tools, and UI never branch on provider format.
- Adding tool calls (Phase 4) means extending `ContentBlock`, not rewriting the client.
- The one translation function is the single place provider quirks live (e.g. OpenAI flattening,
  `singleDollar` math is a *render* concern, not here).

## Prior art
Agents built on a content-block API commonly use those blocks as their internal message types, with the
API client as the boundary. Cascade follows the same pattern, but its boundary translates to OpenAI
(Ollama/Groq/…) — the role a separate translating proxy would otherwise play externally.
