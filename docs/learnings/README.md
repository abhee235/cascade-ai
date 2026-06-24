# Learnings

Conceptual notes on **why the algorithm works** — the deeper Q&A that doesn't fit a build-step guide.

- **ADRs** (`docs/adr/`) = decisions we made.
- **Phase guides** (`docs/guide/`) = what we built each phase + self-check.
- **Learnings** (here) = the "why/how it really works" explanations (loop termination, agent architecture,
  streaming, etc.), captured so they're recallable after the chat is gone.

Each note: the question, the answer in plain terms, how the idea is commonly implemented, and how
Cascade adopts or defers it.

## Notes
- [agentic-loop.md](agentic-loop.md) — how the loop terminates, why "no tool_use = done", and the edge-case backstops.
- [agent-architecture.md](agent-architecture.md) — one main agent vs subagents; static role configs + dynamic spawning.
- [tool-error-handling.md](tool-error-handling.md) — the two layers (generic pipeline catch + tool-specific expected errors); why Glob needs none.
- [why-tools-are-objects.md](why-tools-are-objects.md) — a tool is an object implementing the Tool interface; `call(input, ctx)` is the function; method-shorthand explained.
- [tool-call-binding.md](tool-call-binding.md) — how the LLM's JSON string becomes the tool's typed `input` (Zod schema out + JSON.parse + safeParse in).
- [model-capability-fallbacks.md](model-capability-fallbacks.md) — native tool calls vs JSON-mode vs prompt-based ReAct; fallback lives in the provider, not the loop.
