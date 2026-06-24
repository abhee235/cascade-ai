# ADR-022 — Testing strategy: FakeLLM + deterministic units; F5 is the e2e truth

**Status:** Accepted (after Phase 6, before Phase 7)

## Context
The codebase grew past the point where ad-hoc headless smokes + manual F5 catch regressions, and
Phases 7–13 all touch the loop. We need an autonomous regression net — but without overbuilding, and
without fooling ourselves that green tests mean the app works.

## Decision
- **FakeLLM** (`packages/core/test/fakeProvider.ts`): a `ModelProvider` that replays **scripted
  `StreamEvent`s** (one script per turn) and records the requests it received. This is the keystone —
  it makes the entire engine deterministic and testable **without Ollama** (offline, instant).
- **Vitest** (`vitest run`, config at root) discovers `packages/*/test/**/*.test.ts`.
- **What we test (deterministic core logic):**
  - unit: `scheduler.partition` (parallel/serial/order), `executeTool` (lookup/validate/error pipeline),
    `toOpenAIMessages` (the tool_use↔tool_calls / tool_result↔role:tool bridge);
  - integration: `runAgentLoop` + FakeLLM (tool → re-call → terminal; `maxTurns` backstop; tool_result
    fed back).
- **What we DON'T test in CI:** real-model end-to-end. Real LLMs are slow/nondeterministic. **The F5
  Extension Development Host with a real Ollama model remains the source of truth for e2e behavior**
  (consistent with the `verify` discipline: tests prove logic, running the app proves the app).
- Internal helpers are exported narrowly for tests (`partition`, `toOpenAIMessages`).

## Consequences
- Refactors in Phases 7–13 are guarded: `npm test` (12 tests, <1s) catches loop/scheduler/bridge regressions.
- Tests are **complementary** to F5, not a replacement — a phase still isn't "done" until its F5 queries pass.
- New deterministic logic should get a test; UI/e2e stays manual (F5).

## Prior art
Mature agents pair extensive scripted tests with real runs. Our FakeLLM follows the common idea of
driving the loop with scripted model output to test orchestration without the network.
