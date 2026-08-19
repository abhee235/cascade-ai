# Task: thinking/reasoning-effort control (capability-gated, per model)

Requested 2026-08-19. Not started — waiting for an idle builder (server/core edits restart tsx watch).

## Why
- No knob exists anywhere in Cascade: the ollama provider never sends `think`; openaiChat uses
  `reasoning_effort` only as a learned off-switch; openaiResponses hardcodes `reasoning:{summary:'auto'}`.
- Measured cost of the gap (builder trace 2026-08-19, Qwen3.8-27B @ xhigh default): 30–45s turns dominated
  by reasoning, 15 compactions/53min at a 24K window — thinking burns both clock and context.

## Design (researched, sources in session notes)
1. **Registry/UI**: `thinking?: 'off'|'low'|'medium'|'high'` in ModelParams — same plumbing as
   temperature (registry → ws setModelParams → ModelManager param row → session).
2. **Capability gating** (the ollama-webui pattern): show the dropdown only when the model supports it.
   The pipeline ALREADY exists — modelCaps.ts `/api/show` probe passes `capabilities[]` (incl. `thinking`)
   to the client via the `modelInfo` ws message; the UI just never consumes that entry. Hosted models
   gate off specCapabilities.
3. **Provider mapping**: ollama → `think: false|'low'|'medium'|'high'` (bool for off); openaiChat →
   `reasoning_effort` (minimal/low/medium/high); openaiResponses → `reasoning:{effort}`; llama-server →
   per-request `chat_template_kwargs: {reasoning_effort}` (Qwen3.8 template auto-aliases; no native flag).
4. **Level-vs-boolean quirk**: gpt-oss rejects booleans, some models reject levels (ollama #12004). Reuse
   openaiChat's learned-quirk pattern: send the level, degrade once on the specific 400, remember per model.

## Acceptance
- Dropdown appears only for thinking-capable models; persists per model; a builder run on Qwen3.8 at
  `low` shows materially shorter turns than `xhigh` (baseline trace: builder-2026-08-19-05-48-27.jsonl).
