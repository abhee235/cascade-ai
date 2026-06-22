# Phase 3 — Conversation history + system prompt

**Goal:** Cascade remembers the conversation across turns and is grounded by a system prompt
(identity + environment). Previously `submit()` sent only the current message — amnesia, no grounding.

## 🎯 You'll understand
The model is **stateless**. "Memory" is nothing magical — it's *us resending the whole transcript
every turn*. The system prompt is how we inject identity + facts (cwd/OS/date) the model can't know.

## The 3 ideas
1. **History lives in the core, not the UI.** `session.ts` keeps a `Message[]`; each `submit()` appends
   the user turn, sends the *full* array, then appends the assistant turn.
2. **Stateless → resend everything.** The array grows every turn — which is exactly *why* Phase 10
   needs compaction. The headless smoke proves it: turn 2 ("what's my name?") only works because turn 1
   is resent.
3. **System prompt** = a high-priority `{role:'system'}` message prepended on every request, built by
   `buildSystemPrompt({cwd})` (identity + cwd/OS/date).

## What we built
- `agent/systemPrompt.ts` — `buildSystemPrompt({cwd})` (pure, headless: `node:os` only).
- `llm/provider.ts` — `CompletionRequest.system?`.
- `llm/providers/openaiCompat.ts` — `toOpenAIMessages(messages, system)` prepends `{role:'system'}` (the translation point).
- `session.ts` — keeps `messages: Message[]`; appends user → streams → appends assistant; sends full
  history + fresh system prompt each turn; rolls back the user turn on error; `reset()` clears history.
- `protocol.ts` + `CascadeViewProvider` + `App.tsx` — a **"New chat"** button (`reset` InboundMessage).

## Verification (headless smoke)
```
turn1 "My name is Abhi…" → "OK"
turn2 "What is my name?"  → "Abhi"   ← only works because turn 1 was resent
```

## ✅ Test queries (F5 Dev Host)
1. "My name is Abhi." then "What's my name?" → "Abhi" (history works). Then **New chat** → ask again → it no longer knows (history cleared).
2. "What directory are you in?" → reflects the workspace cwd (system prompt works).

## ✅ Self-check
*The model has no memory — so how does turn 2 know your name?* → The session stores every turn in a
`Message[]` and resends the entire transcript (plus the system prompt) on each request. The "memory"
is the resent history, not anything inside the model.

## Notes
- Assistant turns are stored as text only (thinking is display-only, not resent).
- History grows unbounded for now — Phase 10 adds compaction.
