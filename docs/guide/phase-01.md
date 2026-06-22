# Phase 1 — One-shot Ollama call (no streaming, no tools)

**Goal:** `createSession().submit()` sends your text to a real Ollama model and renders the full reply,
replacing the Phase 0 echo stub.

## 🎯 You'll understand
The model is just an HTTP endpoint. "AI" here is one `POST` with a `messages` array; the reply is text
in `choices[0].message.content`. No magic.

## What we built
- `packages/core/src/llm/modelClient.ts`:
  - `toProviderMessages()` — the **one** place we translate internal content-block messages → OpenAI
    messages (ADR-003). Phase 1 only flattens `text` blocks.
  - `callOllama()` — `POST {baseUrl}/v1/chat/completions` with `{ model, messages, stream:false }`,
    returns the reply text; throws on non-2xx so errors are visible.
- `session.ts` — `submit()` now: emits a `status` ActivityEvent ("Calling <model>…"), calls
  `callOllama()`, emits the reply as a final `message` (rendered whole — activity-first, ADR-013),
  then `turnDone`. Errors and aborts surface as a `⚠️`/`⏹` assistant message. An `AbortController` is
  wired so `abort()` cancels the in-flight fetch (full Stop UX comes in Phase 8).
- Default `cascade.model` set to `qwen36-agentic:latest` (an installed model).

## Why core needed `@types/node`
`fetch` and `AbortController` are **Node globals** (Node 18+). Core runs in Node (the extension host now,
the server in Phase 12), so we added `@types/node` and `"types": ["node"]` — **not** the DOM lib. Core
stays headless: Node types, no browser globals.

## Verification
Headless smoke against live Ollama:
```
status  "Calling qwen36-agentic:latest…"
REPLY:  [{"type":"text","text":"4"}]
turnDone
```

## ✅ Test queries (F5 Dev Host)
1. "What is 2+2? answer with just the number" → `4`.
2. "Write a haiku about TypeScript" → a 3-line reply (proves multi-line handling).

## ✅ Self-check
*What are the minimum fields in the request body, and where is the reply text?*
→ `{ model, messages }` (we add `stream:false`); the reply is `choices[0].message.content`.

## Pitfalls
- `localhost` vs `127.0.0.1` on Windows (use `127.0.0.1`).
- Model name must be installed (`ollama list`); a wrong name returns an HTTP error — now shown in the UI.
- Don't swallow HTTP errors — `callOllama` throws and `submit` renders the message.

## Not yet (deliberately)
- No streaming (Phase 2), no conversation history (Phase 3), no tools (Phase 4). Phase 1 is one-shot.
