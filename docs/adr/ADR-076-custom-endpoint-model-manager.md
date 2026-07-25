# ADR-076 — Configure a custom (remote-GPU) endpoint from the Model Manager

Status: Accepted (2026-07-24)

## Context

The provider layer already supports any OpenAI-compatible endpoint via `baseUrl` + `apiKey` (factory.ts —
vLLM/SGLang/remote-Ollama all flow through `OpenAIChatProvider`), and the server reads `CASCADE_BASE_URL` at
startup. But pointing Cascade at a **rented GPU** (e.g. a Vast.ai box running vLLM) meant editing `.env` and
restarting the server every time — there was no runtime path from the UI. Two concrete gaps:

1. `EnabledModel` had no `baseUrl`/`apiKey`, so a saved custom-endpoint model couldn't send them on activation.
2. `setProviderKey` returns `false` for an unknown provider id (no `KEY_ENV` entry), so the existing
   per-provider key UI couldn't key a custom endpoint at all.

## Decision

Make a custom OpenAI-compatible endpoint a first-class thing you add in the **Model Manager**, no `.env`, no
restart. The endpoint's `baseUrl` + `apiKey` live **on the model** (registry), server-side.

- `EnabledModel` gains `baseUrl?` + `apiKey?`; `addEnabledModel(...baseUrl, apiKey)` persists them (gitignored
  `models.json`, so it survives restart). `modelEndpointFor(provider, model)` returns them for the switch.
- The **key never reaches the browser**: `enabledModelsForClient` strips `apiKey` and sends `hasKey: boolean`
  instead. `EnabledModelInfo` carries `baseUrl` (clean, shown) + `hasKey`, never the secret.
- On `setModel`, the server enriches the config from `modelEndpointFor` (not the client) →
  `manager.setModelConfig({ baseUrl, apiKey, ... })` → `createProvider` (which takes an explicit `apiKey`,
  bypassing the `KEY_ENV` limitation). Boot-restore re-applies the same, so a remote GPU keeps working across
  restarts.
- The Model Manager's Add pane gets a **"Custom endpoint"** section: provider label, model id, endpoint URL,
  API key, context window → one "Add endpoint" action. (Context window is manual — vLLM/SGLang have no
  `/api/show` auto-detect.)

## Files

- `packages/app-protocol/src/index.ts` — `EnabledModelInfo.baseUrl`/`hasKey`; `addModel` gains `baseUrl`/`apiKey`.
- `packages/server/src/modelRegistry.ts` — `EnabledModel.baseUrl`/`apiKey`, `addEnabledModel`, `modelEndpointFor`,
  `enabledModelsForClient` (key-stripping).
- `packages/server/src/wsServer.ts` — `addModel`/`setModel`/boot-restore enrich from the registry; client payload
  uses `enabledModelsForClient`.
- `packages/web/src/lib/store.ts` — `addModel(..., baseUrl, apiKey)`.
- `packages/web/src/components/ModelManager.tsx` — the "Custom endpoint" section.

## Notes / security

- Use a **distinct provider label** (e.g. `vastai`), not `openai` — `openai` routes to the Responses API, which
  vLLM/SGLang don't serve; any other id uses the `/v1/chat/completions` path they do.
- Secure the remote endpoint (API key + TLS, or an SSH tunnel so `baseUrl=http://localhost:<port>/v1`). An open
  vLLM on a public IP is a real exposure.
- The one thing still `.env`-only would be switching the *default startup* model; runtime switching + persistence
  now fully covers the "rent a GPU, point at it" workflow.
