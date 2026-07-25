# ADR-077 — Always cap output; let a custom endpoint declare its wire protocol

Status: Accepted (2026-07-25)

## Context

First real build against a rented GPU (Vast.ai RTX 5090 running Ollama, added via ADR-076's custom endpoint)
surfaced two defects — one that broke builds, one that blinded us.

**1. Builds stalled mid-answer.** The `/v1` adapter only sent `max_tokens` when `maxOutputTokens` was
explicitly configured. The custom endpoint had none, so the BACKEND's default applied and Ollama returned
`finish_reason: "length"` after as few as **38 output tokens**. Cascade correctly reads that as an output-ceiling
hit, so the loop's max-tokens gate fired **6×** in one build and turns ended with empty responses (`tools=[]`,
`text=''`). 43 turns produced only 8 file mutations. Mature agents never omit `max_tokens`; we did, and inherited
whatever the backend felt like.

**2. Zero speed observability — the whole point of renting the GPU.** Provider routing is keyed on the
`provider` **id**. A remote Ollama is necessarily reached under a *custom* label (`vast`), so it fell through to
the generic OpenAI-compatible adapter. Ollama's `/v1` layer reports token COUNTS only — no
`promptEvalMs`/`decodeMs`/`loadMs`. Every KV-cache and throughput observable we tune against (ADR-040) read
**0**, so "is the remote 27B actually faster than local?" was unanswerable.

## Decision

**1. Always send an output cap.** `OpenAIChatProvider.body()` now sends `max_tokens` (or
`max_completion_tokens` for the `openai` id) on every request, defaulting to `DEFAULT_MAX_OUTPUT_TOKENS`
(16384) when the caller pins none. The constant moved to `openaiChat.ts` and is re-exported by `ollama.ts`, so
the native and `/v1` paths cannot drift — a model must not behave differently based on which endpoint reached it.

**2. `ProviderConfig.api?: 'openai' | 'ollama'`** — an explicit wire-protocol override that wins over the id.
`api: 'ollama'` routes to the native `/api/chat` adapter against the configured `baseUrl`, restoring
prefill/decode/load timings for a remote Ollama under any label. Absent ⇒ routing is exactly as before.
Threaded end-to-end: registry (`EnabledModel.api`, persisted) → `addModel`/`setModel`/boot-restore →
`ProjectManager.setModelConfig` → `createProvider`. The Model Manager's custom-endpoint block gains a
**Server type** select (OpenAI-compatible · Ollama native).

Note `baseUrl` normalization (strip trailing `/v1`) already makes one pasted URL work for both adapters.

## Files

- `packages/core/src/llm/providers/openaiChat.ts` — always-cap + exported `DEFAULT_MAX_OUTPUT_TOKENS`.
- `packages/core/src/llm/providers/ollama.ts` — re-exports the shared constant instead of its own copy.
- `packages/core/src/llm/factory.ts` — `api` override.
- `packages/server/src/modelRegistry.ts` — `EnabledModel.api`, `addEnabledModel(..., api)`, `modelEndpointFor`.
- `packages/server/src/wsServer.ts`, `projectManager.ts` — carry `api` through activation + restore.
- `packages/app-protocol/src/index.ts`, `packages/web/src/lib/store.ts`, `ModelManager.tsx` — protocol + UI.
- Tests: `openaiCompat.test.ts` (cap never omitted), `providerFactory.test.ts` (routing, both directions).

## Consequences

- A remote Ollama added with **Server type: Ollama** now yields the same forensics as a local one — so the
  prefill-reprocessing and decode questions that drove the rental can finally be measured remotely.
- The always-cap change is global. 16384 is generous (largest real generation observed ~16k, a Write whose args
  ARE the output), and the loop already treats a max-tokens stop as "continue, act now" rather than a finished
  answer — so a clipped legitimate turn recovers instead of ending the build.
