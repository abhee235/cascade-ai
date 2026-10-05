# ADR-002 — Talk to Ollama via the OpenAI-compatible `/v1/chat/completions`

**Status:** Accepted (Phase 1)

## Context
Cascade is Ollama-native. Ollama exposes two HTTP surfaces: its native `/api/chat`, and an
OpenAI-compatible `/v1/chat/completions`. We need one that supports streaming and tool-calling and
that transfers to other providers.

## Decision
Use the **OpenAI-compatible** endpoint: `POST {baseUrl}/v1/chat/completions`.
- Phase 1 sends `{ model, messages, stream: false }` and reads `choices[0].message.content`.
- All provider I/O is isolated in `llm/modelClient.ts`. `toProviderMessages()` is the single point
  that converts Cascade's internal content-block messages to OpenAI messages (ADR-003).
- `baseUrl` defaults to `http://127.0.0.1:11434`; `model` is a VS Code setting.
- HTTP/transport errors throw and are surfaced in the transcript — never swallowed.

## Consequences
- The OpenAI shape gives us `tools` (Phase 4) and SSE streaming (Phase 2) with the same contract.
- Knowledge transfers: the same client shape works against OpenAI, LM Studio, llama.cpp server, etc.
- We must keep the translation confined to `modelClient.ts`; nothing above it knows about OpenAI.

## Consequences for Windows
Use `127.0.0.1`, not `localhost` — on Windows `localhost` can resolve to IPv6 `::1`, which Ollama
doesn't listen on. (A common pitfall for local proxies in front of Ollama, too.)

## Prior art
Agents built on a single vendor's API commonly call it through one isolated client module (a plain
query call plus a streaming variant). The request/response **shape** differs from vendor to vendor, but
the role is the same: a single isolated client at the model boundary. Cascade's `modelClient.ts` plays
the role of both that client **and** the format bridge that a separate translating proxy would otherwise
perform — we just do the translation in-process.
