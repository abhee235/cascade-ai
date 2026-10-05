# ADR-015 — Memory: a tiered, self-curating subsystem (beyond file injection)

**Status:** Accepted (Phase 10). Memory is its own phase (compaction → Phase 11).

## Context
Cascade is the engine for a production-grade app builder, so memory must be **production-quality**, not a
minimal file. The usual coding-agent memory is **file-injected only**: always in-context (capped, costs tokens
every turn), **no semantic retrieval**, and remembering-beyond-edits is a flat fork-extraction into files. The
research frontier (the MemGPT paper) is **tiered + retrieved + self-curating** — which file-injected agents do
not implement. That's our
opening to build something genuinely better, and Ollama-native (local embeddings, no cloud).

## Decision
A **3-tier, self-curating** memory subsystem:

1. **Core memory** (`memory/memoryStore.ts`) — always in-context, file-backed.
   - **Multi-scope**: project `CASCADE.md` + project-local `CASCADE.local.md` (gitignored) + user
     `~/.cascade/CASCADE.md`; **directory walk** CWD→root; project/closer-to-CWD = higher priority.
   - **`@import`** (`@path`/`@./rel`/`@~/home`/`@/abs`): depth cap, text-extension whitelist, circular-ref
     protection. Injected under an **OVERRIDE header**; capped by lines+bytes.
   - **Structured self-edit tools**: `append` / `replace` / `forget` (not append-only).

2. **Archival memory** (`memory/archival.ts`) — *beyond file injection*: unbounded, **semantically searched on demand**.
   The agent `memory_write`s facts and `memory_search`es them; only relevant hits enter context. Backed by
   **local Ollama embeddings** (`ModelProvider.embed()` → `/api/embeddings`, e.g. `nomic-embed-text`) +
   cosine similarity; persisted as `.cascade/archival.json` (`{id, text, embedding, ts}`).

3. **Recall** — search past sessions/turns on demand (corpus = the JSONL transcripts from ADR-023).

**Self-curation** (revised — see `docs/learnings/memory-write-policy.md`): per-turn blind-append is the naive
design (semantic duplicates, transient facts, memory poisoning + longitudinal drift). The real design is
**event-driven consolidation**: harvest durable facts when context is about to be discarded —
at **compaction** (the chunk being summarized away) and **session-end** — and for each candidate run
ADD/UPDATE/DELETE/NOOP against existing memory (semantic dedup), behind a strict durability/safety gate.
This is **built in Phase 11 alongside compaction** (they couple naturally). In Phase 10 auto-curation ships
**OFF by default** (opt-in `cascade.autoMemory`); the explicit `Memory` tool + proactive retrieval are the
safe paths.

**`/memory` overlay** (like `/mcp`): view / search / edit / forget + write markers.

## Consequences
- Memory **lives outside the compactable history** (re-injected/retrieved fresh) — compaction never erases it.
- Archival retrieval scales to "remember everything about this app/project" without bloating context — the
  capability an app-builder backend needs and file-only memory lacks.
- New dependency surface: `ModelProvider.embed()` and a small vector store (cosine over a JSON file; SQLite
  later if needed). Embeddings are optional — archival degrades to keyword search if `embed` is unavailable.
- Build order (each a complete, tested layer): Tier-1 core (foundation done) → full core (scope/walk/import/
  edit tools) → archival (embeddings + search) → self-curation → `/memory` overlay.

## Prior art
File-based agent memory: tiered instruction files + `@import` + fork-extraction into files — but
**file-only, no semantic recall**. MemGPT-style tiered memory: core (in-context) + archival (vector,
tool-searched) + recall, agent self-edits via tools, sleeptime curation — the architecture we adopt and
localize.
