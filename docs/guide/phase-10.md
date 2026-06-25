# Phase 10 — Persistent memory (a tiered, self-curating subsystem)

**Goal:** durable memory that survives sessions — not a single injected file, but a **3-tier** system with
**semantic retrieval** and **proactive recall**, all local (Ollama embeddings). Memory becomes its own phase;
**compaction moves to Phase 11**.

## 🎯 You'll understand
- Why memory lives **outside** the conversation history (so compaction never erases it).
- The OS-style tiering from agent-memory research — **core** (always in-context) vs **archival**
  (retrieved on demand) — and why file-only memory is weaker.
- That recall must be **automatic** (proactive retrieval), not dependent on the model calling a search tool.
- Why **auto-writing memory every turn is the wrong design** (poisoning, drift, bloat) — see
  `docs/learnings/memory-write-policy.md`.

## What we built (ADR-015)
**Tier 1 — Core** (`memory/memoryStore.ts`): always-in-context, file-backed.
- Multi-scope: project `CASCADE.md` + project-local `CASCADE.local.md` + user `~/.cascade/CASCADE.md`;
  **directory walk** CWD→root (closer = higher priority); injected under an **OVERRIDE header**, capped.
- **`@import`** (`@./x.md`): depth-capped, extension-whitelisted, circular-safe, code-fence-aware.
- `Memory` tool: **append / replace / forget** (structured self-edit).

**Tier 2 — Archival** (`memory/archival.ts`) — *beyond file-only memory*: unbounded, **semantically searched**.
- `ModelProvider.embed()` → Ollama `/v1/embeddings` (`nomic-embed-text`); `.cascade/archival.json` store;
  cosine ranking; **keyword (token-overlap) fallback** when no embedder.
- `MemorySearch` tool (read-only, auto-allowed); `Memory` tool `scope: archival`.

**Proactive retrieval** (`session.ts` + `systemPrompt.ts`): each turn auto-searches archival with the user's
message and **injects the relevant hits** into the system prompt ("Possibly relevant memories…") — so recall
is automatic, not reliant on the model choosing to search.

**`/memory` overlay**: view core, semantic-search archival, forget entries.

**Self-curation**: OPT-IN only (`cascade.autoMemory`, default **off**). Per-turn append is naive; Phase 11
replaces it with **event-driven, consolidating** curation (at compaction + session-end) — see below.

## ✅ Test queries (F5)
1. "Remember we use pnpm here, not npm." → `Memory` (Allow) → `/memory` shows it in Core.
2. **+ New chat** → "which package manager?" → **proactive retrieval** injects it → answers **pnpm** (the
   trace `system` field shows a "Possibly relevant memories" section). No `MemorySearch` call needed.
3. Archive a detailed fact (`Memory` scope archival), then search it in `/memory` → ranked by similarity.

## ✅ Self-check
*Why does memory survive a New chat when history doesn't, and why is recall made automatic instead of a
tool the model calls?* → Memory is read fresh from files / retrieved each turn and injected into the system
prompt — it's never part of the (clearable, compactable) conversation history. Recall is auto-injected
because local models won't reliably choose to call a search tool, so we retrieve for them.

## Tests
`memory.test.ts`, `archival.test.ts`, `curator.test.ts`, and **`memory.integration.test.ts`** (drives
`runAgentLoop` end-to-end: Memory→core, MemorySearch retrieval; + a **live** Ollama-embeddings test gated by
`CASCADE_LIVE=1`). 50 deterministic + 1 live.

## Pitfalls / decisions
- **Don't auto-write every turn** (duplicates, transient facts, memory poisoning, longitudinal drift). Auto
  curation is off; the real version is event-driven consolidation in Phase 11.
- Retrieved memory is **lower trust** than core (labeled "verify before relying").
- Archival dedups exact repeats; semantic dedup + ADD/UPDATE/DELETE/NOOP come with consolidation (Phase 11).

## Deferred to Phase 11 (coupled with compaction)
Event-driven, Mem0-style **consolidating** self-curation; recall (raw-transcript search); per-user scoping
for the web frontend.
