# Memory WRITE policy — why per-turn blind-append is wrong, and the best way

The user pushed back on auto-curation saving to memory **every turn** ("what if nothing to save, or
duplicate/redundant, or only relevant to that moment?"). They're right. This note captures the edge cases,
the researched consequences, and the production-grade design.

## Edge cases / failure modes of per-turn blind-append
1. **Nothing durable** — most turns have no lasting fact, but we still make an extraction call (latency/cost)
   and a weak model may **hallucinate filler facts** to fill the array.
2. **Semantic duplicates** — exact-match dedup misses "prefers tabs" vs "likes tabs over spaces" vs
   "indentation: tabs". Memory fills with near-copies.
3. **Transient / context-specific facts** — "looking at file X", "the error was on line 42", "the value is
   3 right now" — true *now*, misleading later.
4. **Task state misclassified as preference** — "wants to refactor auth" (a task, not a standing fact).
5. **Contradiction over time** — `uses npm` saved, later `uses pnpm` saved; both persist → conflicting
   retrieval, no supersede.
6. **Speculative / inferred facts** — model saves "user probably likes X" → becomes self-reinforcing
   **false memory**.
7. **Secrets / PII / pasted content** — auto-persisting tokens, keys, or large pasted blobs to disk
   (privacy + a bigger attack surface).
8. **Prompt-injection poisoning** — malicious text in a tool result / web page gets "extracted" as a fact and
   **persists across sessions** (see consequences).
9. **Unbounded growth** — every turn adds rows → retrieval becomes needle-in-a-haystack; search slows; noise
   crowds out signal.
10. **Retrieval pollution** — low-relevance facts injected each turn → recency dominance, instruction
    conflicts, distraction.
11. **Cost / latency** — an extra LLM call **every turn** (doubles round-trips — painful on local models).
12. **Cross-tenant/project leakage** — for the web North Star, one user's auto-saved memory surfacing for
    another.
13. **Weak-model extraction** — small local models emit malformed/over-broad JSON, occasionally "saving the
    whole conversation."

## Researched consequences (it's not just bloat)
- **Memory poisoning / persistence**: bad data in long-term memory is retrieved and **treated as trusted
  truth**, quietly redirecting reasoning/tool-use **across future sessions** — more covert and persistent
  than a one-shot attack. [SecureFlag], [Unit42], [MemoryGraft].
- **Longitudinal safety drift**: even with **no attacker**, benign accumulation drifts an agent unsafe over
  time; compressed summaries act as a "laundering channel." [temporal memory contamination].
- **Context pollution**: verbose/redundant memory causes needle-in-a-haystack, recency dominance, and
  instruction conflicts — degrading accuracy. [memory-bloat research].
- **Multi-tenant leakage**: shared (un-segmented) memory leaks between users. [survey].

## The best way — a CONSOLIDATION pipeline (from published memory research)
Don't append; **consolidate**. The published pipeline = extraction → **update** → retrieval. For each candidate
fact, semantically retrieve similar existing memories, then the LLM picks one **operation**:
- **ADD** — no semantically-equivalent memory exists.
- **UPDATE** — augment/refine an existing memory (merge, don't duplicate).
- **DELETE** — the new fact contradicts an old one (supersede).
- **NOOP** — candidate adds nothing → do nothing.
This fixes duplicates (NOOP/UPDATE), contradictions (DELETE+ADD), and "nothing to save" (NOOP/empty).

## Recommended design for Cascade (local-native, production-grade)
1. **Change WHEN — don't curate every turn.** Curate at **session end** (or every N user turns / on a
   debounce). More context to judge durability, far fewer calls, less noise. (The published pipeline runs per
   message pair *but always consolidates*; batching is cheaper for local models.)
2. **Change HOW — consolidate, don't append.** Before writing a candidate: embed it, semantic-search
   existing memory; if cosine ≥ ~0.85 → **NOOP/UPDATE** (dedupe/merge); if it contradicts → **supersede**;
   else **ADD**. A small LLM "operation" call only when there's a near-match (cheap path otherwise).
3. **Change WHAT — strict durability gate.** Extraction prompt: ONLY standing preferences/conventions/
   decisions; explicitly **exclude** transient state, task intents, secrets, and large/pasted content. Cap
   length per fact.
4. **Safety guards.** Never auto-save secret-like strings; don't treat tool-output/web text as fact-source
   (injection surface); label retrieved memory low-trust (we already do); **scope per project/user**
   (segmentation) for the web North Star.
5. **Default conservative + configurable.** Given the risks, default auto-curation to **session-end +
   consolidation** (or even OFF, with the explicit `Memory` tool as the primary path); make it a setting.

## Best trigger: tie curation to INFORMATION-LOSS events (Cascade improvement)
The right moment to harvest durable facts is exactly when context is about to be **discarded**:
- **At compaction** — old turns are being summarized away; extract durable facts from that chunk *before*
  it's lost.
- **At session end / New chat** — final harvest (backstop; short sessions may never compact).
Event-driven ⇒ zero cost on normal turns, context-rich (you have the exact chunk leaving), and writes align
with information loss. This is **cleaner than the common design**, which *decouples* them: it extracts at
turn-end via a stop-hook forked agent, while compaction's summary goes into the session boundary, **not**
durable memory. Cascade couples curation to compaction + session-end → built in Phase 11.

## Net
Replace **per-turn blind-append** with **selective timing + research-style consolidation (ADD/UPDATE/DELETE/NOOP)
+ durability/safety gating**. The explicit `Memory` tool stays the high-trust path; auto-curation becomes a
careful background consolidator, not a firehose.

Sources: a 2025 memory-consolidation paper (arxiv 2504.19413); SecureFlag memory/context poisoning; Palo Alto Unit42
"indirect prompt injection poisons long-term memory"; "temporal memory contamination" (longitudinal drift);
MemoryGraft (poisoned experience retrieval).
