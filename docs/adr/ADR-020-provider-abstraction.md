# ADR-020 — Provider-agnostic model access (interface + factory + DI)

**Status:** Accepted (introduced after Phase 1, before Phase 2)

## Context
Cascade must not be tied to Ollama. We want to attach OpenAI, Groq, OpenRouter, llama.cpp, other vendors,
etc. by **configuration**, and keep the core testable. Calling a vendor SDK directly from the session
would weld the engine to one provider and block that.

## Decision
A small **provider abstraction**, owned by us (not a library — see "Alternatives"):

- **Interface** (`llm/provider.ts`): `ModelProvider` with `complete(req, signal)` (Phase 2 adds
  `stream()`). The core/session depends ONLY on this interface.
- **Implementations** (`llm/providers/*`): `OpenAICompatProvider` covers Ollama, OpenAI, Groq,
  OpenRouter, and llama.cpp — they all speak `POST {baseUrl}/v1/chat/completions`, differing only by
  `baseUrl` + `apiKey`. A vendor with a different wire format will get its own provider when needed.
- **Factory** (`llm/factory.ts`): `createProvider(config)` maps a provider id → a concrete provider
  with a default `baseUrl`. New providers are added in this one place.
- **Dependency injection**: `createSession({ provider, model, cwd })` receives a built provider. The
  frontend reads config (`cascade.provider/model/baseUrl/apiKey`), calls `createProvider()`, injects it.
- **Translation stays at the provider boundary** (ADR-003): the internal message model is
  provider-neutral; each provider converts to its wire format inside itself.

## Consequences
- Add a provider = one factory branch (+ a class for non-OpenAI-compat vendors). No core changes.
- The core is unit-testable with a fake `ModelProvider`.
- Slightly more indirection than a direct call — worth it; this is the seam the whole model layer hangs on.

## Alternatives considered
- **Vercel AI SDK / LangChain.js / official `openai` SDK with baseURL**: real libraries that do this.
  Rejected as the *primary* path because Cascade is a tutorial — a library hides streaming, tool-call
  accumulation, and translation, which are the lessons (Phase 2/4). Our abstraction is tiny anyway
  (one compat provider + a factory). A library could still be slotted *behind* one provider later.

## Prior art
Single-vendor agents commonly select a backend behind one client interface — the vendor's own API or one
of several cloud resellers. Same idea: the loop calls one client; backend choice is config. Cascade's
`ModelProvider` + `createProvider()` ≈ that selection.
