# ADR-062 — Hosted providers: OpenAI, NVIDIA NIM, and any OpenAI-compatible endpoint

Status: **accepted** · 2026-07-20 · builds on ADR-020 (provider abstraction)

## Context

Cascade was deliberately Ollama-first (local, open-source models — objective met). Next objective:
the SAME engine against hosted backends — OpenAI first, then API-based OpenAI-compatible endpoints
(NVIDIA NIM `integrate.api.nvidia.com`, OpenRouter, Together, vLLM…). ADR-020 already put the seam in
the right place: core depends only on `ModelProvider`, and `OpenAICompatProvider` speaks the generic
`/v1/chat/completions` + Bearer wire format with every Ollama-native behavior (window enforcement,
`/api/show` probing, crash recovery, image path) gated on `cfg.id === 'ollama'`. So "add OpenAI" is
NOT a new client — it's config plumbing plus three wire-format truths about hosted APIs.

## Decision

1. **Known ids stay a one-line map** (`llm/factory.ts`): `nvidia → https://integrate.api.nvidia.com`
   joins openai/groq/openrouter. **Unknown ids become the generic "api-based" provider**: any
   `provider` id + explicit `baseUrl` gets the compat adapter (id labels logs only). No code change
   for the next vendor.
2. **Keys resolve config-first, then conventional env vars** (`OPENAI_API_KEY`, `NVIDIA_API_KEY`,
   `GROQ_API_KEY`, `OPENROUTER_API_KEY`), then generic `CASCADE_API_KEY`. Keys live in `.env`
   (gitignored; `.env.example` documents the shape) — never in committed settings. The server loads
   `.env` itself (`loadDotEnv.ts`, zero-dep, first import) with REAL env always winning, so
   `CASCADE_PROVIDER=ollama npm run dev` overrides the file.
3. **Server config**: `CASCADE_PROVIDER` (+ existing `CASCADE_MODEL`/`CASCADE_BASE_URL`) replaces the
   hardcoded `'ollama'` in `projectManager.ts`. Boot **fails fast** on a hosted provider with no key,
   or a provider with no default model — a clear startup error beats a cryptic 401 twenty turns into
   a build. Default models only where a universal one exists (ollama → qwen2.5-coder, openai →
   gpt-5-mini); vendor-prefixed catalogs (nvidia/openrouter) require an explicit model.
4. **Wire-format truths** (in `openaiCompat.ts`, keyed on provider id):
   - OpenAI's current models (gpt-5.x, o-series) reject `max_tokens` → send `max_completion_tokens`
     for `id === 'openai'` only; every other compat backend only knows `max_tokens`.
   - Reasoning streams under two names in the wild: `delta.reasoning` (OpenRouter, Ollama /v1) and
     `delta.reasoning_content` (DeepSeek convention — NVIDIA NIM, Fireworks, vLLM). Accept both.
   - `detectModelLimits` (`/api/show`) is Ollama-native → skip for hosted ids (was a wasted RTT per
     session against api.openai.com); hosted windows come from the static map (gpt-5 → 400k,
     gpt-4.1 → 1M, o-series → 200k added).
5. **Capabilities stay inert-by-default** (`modelCaps.ts`): Ollama keeps the live `/api/show` probe;
   hosted models get vision from a static famously-multimodal family list (gpt-4o/4.1/5, o-series,
   the other major hosted frontier families, llava/qwen-vl/pixtral + gateway-prefixed ids). Unknown hosted model ⇒ claims
   nothing ⇒ Browser tool stays off — wrong-OFF degrades gracefully, wrong-ON hands the model a tool
   that errors on every screenshot.

## Consequences

- Extension: `cascade.provider` enum gains `nvidia` + `custom`; `cascade.apiKey` description now
  steers users to env vars (settings sync uploads values in plain text).
- Eval harness works against hosted backends unchanged (`--provider openai` + env key) — enables
  strong-gate comparisons (ADR-quality rungs) against frontier models.
- Vendor-native wire formats (e.g. a `/v1/messages` API) remain explicitly out of the compat path — each its
  own provider when needed.
- Verified: 414 tests pass (new: factory routing/key-resolution, `max_completion_tokens` split,
  `reasoning_content` deltas, no hosted `/api/show` probe); boot fail-fast + `.env` precedence
  exercised live.
