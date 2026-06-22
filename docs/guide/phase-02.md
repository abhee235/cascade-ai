# Phase 2 — Streaming + thinking (live), with an activity view

**Goal:** stream the model's prose **and** reasoning token-by-token to the UI (like the common IDE
assistants), while keeping a coarse activity `status` and the `ActivityEvent` protocol that later carries
tool-step activity. (ADR-013, as corrected — we *do* stream prose.)

## 🎯 You'll understand
The async-generator producer→consumer pipeline (provider `StreamEvent` → session → frontend
`ActivityEvent`), and how live streaming and an activity view coexist.

## The 3 ideas
1. **SSE streaming.** `stream:true` → many `data: {...}` lines. We read the body, **buffer the partial
   trailing line** across chunks, parse each line, and yield typed `StreamEvent`s. (ADR-004)
2. **Two event layers.** The provider yields internal `StreamEvent`s; the session translates them to
   frontend `ActivityEvent`s. We forward `text_delta`/`thinking_delta` live, and emit a final `message`
   the UI commits (authoritative; Phase 3 stores it).
3. **`delta.reasoning` → thinking.** `qwen36-agentic` puts reasoning in a separate field → streamed into
   a live (then collapsible) Thinking section, separate from the answer.

## What we built
- `llm/provider.ts` — `StreamEvent` union + `stream()` on `ModelProvider`.
- `llm/providers/openaiCompat.ts` — `stream()`: fetch `stream:true`, reader + `TextDecoder`, line
  buffering, `delta.content`→`text_delta`, `delta.reasoning`→`thinking_delta`, `[DONE]`/`finish_reason`.
- `protocol.ts` — `ActivityEvent` gains `text_delta` + `thinking_delta` (deltas cross to the UI).
- `session.ts` — consume `stream()`, forward deltas live, accumulate, emit final `message`.
- `ui/App.tsx` — a live-growing assistant bubble (with a caret) + live Thinking section; finalize on `message`.

## Verification (headless smoke)
```
STATUS: Thinking…
text_delta events: N   thinking_delta events: 202   (deltas streamed live)
FINAL message blocks: thinking+text
turnDone
```

## ✅ Test queries (F5 Dev Host)
1. "What is 2+2? Think briefly, then answer." → reasoning streams into the Thinking section live; the
   answer appears (token-by-token for longer outputs); finalized cleanly.
2. "Explain closures in three paragraphs." → text streams word-by-word with a caret.

## ✅ Self-check
*What are the two event layers, and where does the translation happen?* → Provider yields internal
`StreamEvent`s; the **session** translates them into frontend `ActivityEvent`s (forwarding deltas live
and emitting a final `message`). The frontend only ever renders `ActivityEvent`s.

## Pitfalls
- Don't `JSON.parse` a line without buffering partial lines across network chunks.
- Thinking deltas precede content deltas for reasoning models.
- The final `message` is authoritative — the UI replaces its live buffer with it.

## Not yet (deliberately)
- No conversation history (Phase 3), no tools (Phase 4). Tool-step activity cards + Stop: Phase 8.
