# ADR-063 — OpenAI Responses API: reasoning + tools together

Status: **accepted** · 2026-07-20 · builds on ADR-062 (hosted providers)

## Context

Adding OpenAI (ADR-062) surfaced a hard limit on the legacy `/v1/chat/completions` endpoint: OpenAI's
newer reasoning models (gpt-5.6-luna and up) **reject function tools when reasoning is on** —
`HTTP 400: "Function tools with reasoning_effort are not supported … use /v1/responses or set
reasoning_effort to 'none'"`. Probed live (2026-07-20):

| endpoint / knobs | result |
|---|---|
| chat/completions + tools + `reasoning_effort:'none'` | 200 — tools work, **reasoning off** |
| chat/completions + tools + `reasoning_effort:'low'` | 400 — any reasoning + tools rejected |
| `/v1/responses` + tools (default reasoning) | 200 — tools **and** reasoning |

ADR-062 shipped an adaptive `reasoning_effort:'none'` retry as a stopgap — but that buys tool support
by *disabling reasoning* on exactly the frontier models you'd choose for their reasoning. For a
best-in-class coding agent that's the wrong trade. `/v1/responses` is where OpenAI moved reasoning+tools
and is the strategic path for all current models.

## Decision

**Route the OpenAI agent loop (`stream()`) through `/v1/responses`; everything else stays on
chat/completions.** Provider id `openai` → Responses; nvidia/groq/openrouter/ollama/custom are
OpenAI-*compatible* on chat/completions (not Responses) and are unchanged.

- **Stateless replay** (`store: false`): Cascade owns the conversation, so we translate the full
  provider-neutral history to a Responses `input` list each turn — no `previous_response_id`, no
  server-side session (keeps the provider model identical to every other backend). Verified across a
  7-step live tool loop that replaying `function_call` / `function_call_output` items (keyed by our
  internal id as `call_id`) does NOT trip the "reasoning item required" error — prior reasoning is
  simply omitted and the model reasons fresh each turn.
- **Wire translation** (`toResponsesInput`, exported + unit-tested): system → `instructions`;
  user text → string-content item; images → `input_text` + `input_image`; assistant text →
  `output_text`; `tool_use` → `function_call`; `tool_result` → `function_call_output`. Tools are FLAT
  (`{type:'function', name, description, parameters}`), not nested under `function`.
- **Streaming** (event shapes captured live, not guessed): text on `response.output_text.delta`,
  reasoning summary on `response.reasoning_summary_text.delta` (→ `thinking_delta`, streamed to the
  UI via `reasoning:{summary:'auto'}`), a COMPLETE tool call on `response.output_item.done` where
  `item.type==='function_call'` (no delta accumulation), usage + truncation on `response.completed`.
- **No temperature** on this path — reasoning models reject non-default temperature (eval determinism
  is moot for a reasoning model anyway). `max_output_tokens` caps reasoning+answer together.
- **complete()** (non-streaming: compaction summaries, memory curation) stays on chat/completions —
  those calls carry no tools, so they never hit the 400, and they don't want reasoning overhead. The
  ADR-062 adaptive retry remains as the safety net there (and for OpenAI-compat gateways like
  OpenRouter that proxy to OpenAI reasoning models over chat/completions).

## Consequences

- gpt-5.6-luna (and future OpenAI reasoning models) run Cascade's full tool loop **with reasoning on**
  — confirmed live: 7-step Write→Read→Glob→Bash loop, reasoning summaries streamed, usage reported.
- One caveat: models NOT on the Responses API (e.g. gpt-3.5-turbo) would now 400 on OpenAI — a
  non-issue for a coding agent, documented here rather than special-cased.
- Vendor-native `/v1/messages`-style APIs remain separate future providers (unchanged from ADR-062).
- Verified: 428 tests pass (new: `toResponsesInput` translation, mocked `/v1/responses` SSE parse,
  endpoint-routing guard); both core + server typecheck.
