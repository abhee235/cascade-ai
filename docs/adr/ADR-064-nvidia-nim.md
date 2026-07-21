# ADR-064 — NVIDIA NIM + hosted-model robustness (window sizing, single-tool templates)

Status: **accepted** · 2026-07-21 · builds on ADR-062 (hosted providers)

## Context

NVIDIA NIM (`integrate.api.nvidia.com`) is OpenAI-compatible on `/v1/chat/completions`, so the provider
wiring landed for free in ADR-062 (base URL + `NVIDIA_API_KEY` + `reasoning_content` deltas). Taking it
live against a real key surfaced three things the wiring alone didn't cover — two environment realities
and one genuine engine bug.

## Decisions

### 1. Context-window map for hosted coder models (real bug)
`detectModelLimits` probes `/api/show`, which is **Ollama-only** — a NIM model returns `{}` and falls to
`contextWindowForModel(model)`, which knew no NIM ids → `DEFAULT_WINDOW` (8k). So `moonshotai/kimi-k2-instruct`
(128k native) would compact ~16× too early. Added native windows for the common hosted coder families
(Kimi K2 128k / K2.5+ 256k, Qwen3-Coder 256k, DeepSeek V3/R1 128k, Llama-3.1/3.3/Nemotron 128k), each
ordered before its generic local rule (first match wins). Windows verified 2026-07-20 (NVIDIA docs / model cards).

### 2. `CASCADE_CONTEXT_WINDOW` override (escape hatch)
A specific NIM endpoint may **serve** a smaller window than the model's native max, and there's no live
probe to discover it. Added `CASCADE_CONTEXT_WINDOW` (server) → `ProjectManagerOptions.contextWindow` →
`createSession`, so a user can pin the real window when the map guess is wrong. Under-sizing is safe
(early compaction); over-sizing 400s visibly — the override exists for the latter.

### 3. Adaptive single-tool-call handling (real engine bug)
Measured on `meta/llama-3.1-8b-instruct` via NIM: its prompt template **500s** —
`"This model only supports single tool-calls at once"` — whenever an assistant turn carries **2+
tool_calls**. Cascade legitimately emits parallel tool calls (reads run in parallel, ADR-008), so the
model's first parallel turn poisons history and **every later replay 500s** — a wedged session.

Probed the failure precisely (throwaway harness): a fresh single call → 200; replaying one prior call +
result → 200 (sequential loops are fine); replaying a 2-call turn → 500; and `parallel_tool_calls:false`
does **not** prevent it (the flag governs generation, not the already-recorded turn). So neither a blanket
flag nor an after-the-fact retry alone can fix it.

Fix — **learned per model, inert until triggered** (no tier-wide cap; capable models keep parallel calls):
on that exact 500, `postChat` records the model in `forceSingleTool` and retries. Thereafter:
- **History collapse** (`toOpenAIMessages({singleToolCall})`): keep only the first tool_call of each
  assistant turn and drop the orphaned tool_results — so the already-poisoned turn replays cleanly.
- **Emission cap** (`stream()`): surface only the first tool_use per turn, so no *new* multi-call turn is
  ever recorded. The loop just takes another turn for the rest; nothing is lost.

This self-heals after a single 500 and never touches models (Ollama, OpenAI/Responses) that don't emit
the error — consistent with the inert-by-default rule.

## Consequences

- Live-verified end-to-end on NIM `llama-3.1-8b`: Stage-1 stream + a full agent loop (Write→Read→Bash,
  self-healing the parallel-call 500 mid-loop) with the file correctly written.
- **Account/catalog reality (not our code), documented for the user:** on the test account
  `kimi-k2.6` → 404 "not found for account" (listed but not enabled), `kimi-k2-instruct` /
  `qwen3-coder-480b` → 410 Gone (retired), `llama-3.3-70b` currently times out (NIM capacity),
  `llama-3.1-8b` works. Model availability is per-account on build.nvidia.com.
- 436 tests pass (new: window-map entries, `singleToolCall` collapse + orphan-result drop, the 500
  learn-and-retry); core + server typecheck.
