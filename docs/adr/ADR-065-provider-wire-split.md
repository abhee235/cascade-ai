# ADR-065 — Split the provider adapter by WIRE FORMAT, not by vendor

Status: **accepted** · 2026-07-21 · refines ADR-020 (provider abstraction)

## Context

`llm/providers/openaiCompat.ts` had grown to 605 lines because three genuinely different wire protocols
were living in one class, selected by `if (cfg.id === 'openai')` / `if (cfg.id === 'ollama')` branches:

- OpenAI **chat/completions** (nvidia, groq, openrouter, llamacpp, custom, and Ollama's /v1),
- OpenAI **Responses** `/v1/responses` (ADR-063 — reasoning + tools),
- Ollama **native** `/api/chat` (num_ctx enforcement, images, recover, /api/show).

With two more vendor-native APIs on the roadmap (each a further distinct protocol), that file was on track to
keep absorbing unrelated wire formats.

## Decision

**Organize by wire format, one module per protocol** — NOT one file per vendor (vendors that share a
protocol would be ~95% duplicate copies, and every fix would need applying N times). The `ModelProvider`
interface stays the seam; the factory maps a vendor id to the right adapter.

```
llm/providers/
  shared.ts           asBlocks / textOf (the only cross-adapter helpers)
  openaiChat.ts       OpenAIChatProvider  — chat/completions BASE; owns the adaptive
                      reasoning+tools and single-tool learned quirks. Used by nvidia,
                      groq, openrouter, llamacpp, custom, and any unknown id + baseUrl.
  openaiResponses.ts  OpenAIResponsesProvider extends chat; overrides stream() → /v1/responses.
  ollama.ts           OllamaProvider extends chat; overrides stream() → native /api/chat,
                      and adds the Ollama-only detectModelLimits / recover / alive.
```

`factory.ts`: `id==='ollama' → OllamaProvider`, `id==='openai' → OpenAIResponsesProvider`, everything
else → `OpenAIChatProvider`. A new OpenAI-compatible vendor still needs **zero** code (base-URL entry or
explicit `baseUrl`); a genuinely new protocol (a vendor-native `generateContent` or `/v1/messages` API) becomes
one new self-contained file implementing `ModelProvider`.

Inheritance carries its weight here: `complete()` / `embed()` / `postChat()` / `body()` live once on the
base; Ollama and Responses override only `stream()`. The learned-quirk state (`forceReasoningNone`,
`forceSingleTool`) is base-owned, so it protects every chat-family vendor.

A real cleanup fell out of the split: `detectModelLimits` / `recover` / `alive` are Ollama-native and now
exist ONLY on `OllamaProvider`. Previously the single class implemented them for all ids with an internal
`if (id !== 'ollama') return {}` guard, so hosted providers advertised a misleading `alive()` (which 404s
on `/api/tags`). Callers already treat these as optional (`agentLoop.ts` / `session.ts` null-check them),
so hosted adapters correctly expose nothing.

## Consequences

- No behavior change — pure code movement behind the interface. Verified: core + server typecheck; 435
  tests pass (the ~40 provider tests now name the adapter they exercise — `OpenAIChatProvider`,
  `OpenAIResponsesProvider`, `OllamaProvider`); a live NVIDIA smoke (Write→Read→Bash with the single-tool
  self-heal) passes through the refactored factory path.
- Each file is now single-protocol and < 300 lines. Adding a vendor-native API touches only the factory + one
  new file; the chat family is untouched.
- Trade-off accepted: total line count rose slightly (652 vs 605) from per-file headers/imports — the cost
  of separation, paid once.
