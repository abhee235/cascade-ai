# System Design: Context Compaction + Persistent Memory (Phase 10)

A design note: how "smart" compaction and durable memory work, how they compare to the best production and
research systems, and what Cascade builds vs defers.

## The core problem
The model is **stateless**: every turn we resend the whole transcript (you can see this in the JSONL trace —
each `model_request` carries all prior messages). That creates two distinct failures:
1. **Context overflow** — the window is finite; history (especially tool output like Bash/Read) grows until it
   no longer fits. → solved by **compaction**.
2. **Cross-session amnesia** — history is per-session and (after compaction) lossy; "remember I prefer tabs"
   dies on New chat / restart. → solved by **persistent memory**.

They're complementary: **memory lives OUTSIDE the compactable history** (re-injected fresh every session), so
compaction can never delete it. Durable facts → memory; transient work → (compactable) history.

---

## Part 1 — Compaction

### The design space (worst → best for a coding agent)
| Approach | Idea | Problem |
|---|---|---|
| **Sliding-window truncation** | drop oldest messages | agent forgets decisions/tool results — silent amnesia |
| **Summarize-old, keep-recent** ⭐ | summarize older turns into a structured block; keep recent N verbatim | the standard in production coding agents |
| **Hierarchical summarization** | summaries of summaries | for *very* long runs; more complex |
| **RAG over conversation** | offload old turns to a vector store, retrieve on demand | unbounded recall, but infra + retrieval errors |
| **Structured running state** | maintain a scratchpad updated each turn | great for narrow tasks, brittle generally |

### How the best production agents do it
Checked **before every API call**, as a **pipeline of cheap→expensive reductions** so that if a cheaper step
gets you under threshold, full summarization is skipped and granular context is preserved:
```
msgs = messagesAfterLastBoundary(msgs)   # start past the last boundary marker
msgs = toolResultBudget(msgs)            # per-message tool-output cap (separate layer, see below)
msgs = snip(msgs)                        # drop snippable items
msgs = microcompact(msgs)                # compress individual large items
msgs = collapse(msgs)
{ result } = autocompact(msgs)           # ← the summarize step, only if still over threshold
```
**Threshold:**
```
summaryReserve  = min(maxOutputTokens(model), 20_000)   # room to GENERATE the summary
effectiveWindow = contextWindow(model) - summaryReserve
buffer          = 13_000                                 # headroom (check is pre-call; a full response can land between checks)
threshold       = effectiveWindow - buffer               # ≈ window − 33k on a 200k model (~83.5%)
fires when tokenCount(msgs) >= threshold
```
- **Circuit breaker**: stop after 3 consecutive autocompact failures so an irrecoverably-over-limit
  session doesn't hammer the model every turn.
- **Full vs partial**: the default replaces *everything* after the boundary with one summary, then **re-injects**
  the 5 most-recently-read files (≤5k tokens each, ≤50k total). A **partial** variant keeps a **verbatim recent
  segment** and summarizes only the older side of a pivot — *this is the model for small windows.*
- **Structured 9-section summary**: the model first drafts a scratchpad analysis (stripped before use), then
  writes a summary with nine fixed sections: **1** the user's request & intent · **2** key technical concepts ·
  **3** files & code (+why each matters) · **4** errors & fixes (+user feedback) · **5** problem solving ·
  **6** every user message · **7** pending tasks · **8** current work · **9** the next step (quoting verbatim
  where work left off, to prevent drift). Tool use is **denied** during summarization.
- **The replacement = a boundary marker, not a delete**: the post-compact history is
  `[boundaryMarker, ...summary, ...keptMessages, ...reInjectedFiles]`. The marker records the pre-compact token
  count and the next loop only reads messages *after* it — the raw transcript file is untouched. The summary is
  wrapped as a synthetic user message that tells the model the session continues from an earlier conversation
  that ran out of context, and to resume directly.
- Best practice: compact **proactively** (~60%) for a better summary while there's headroom.

### Tool-output handling — a SEPARATE, EARLIER layer (not part of summarize)
- **Per-result**: any single tool result over 50k chars → written to disk, model gets a **preview + file
  path**.
- **Per-message**: a tool-result budget caps the *sum* of tool_results in one turn at 200k chars (largest
  offloaded to disk first). Hard ceiling 100k tokens per tool result.
- It's **head-preview + disk-offload**, not head+tail elision. (For Cascade: simple head+tail with a marker.)

### Is "summarize-keep-recent" best-in-world?
**For coding agents, yes — it's the current consensus** (the major coding agents all converge on it). The
honest caveats / frontier:
- **Microcompaction** — compress *individual* large items rather than re-summarizing the whole history (less lossy).
- **RAG/external recall** — for truly unbounded history, retrieve old turns on demand (a "recall memory" tier).
These are refinements, not replacements. The structured-summary approach is the sweet spot for our scope.

### Dynamic context sizing — NO hardcoded buffers (decided)
Cascade is provider-agnostic (8k Ollama ↔ 128k OpenAI), so absolute 20k/13k buffers sized for a 200k window
don't transfer.
**Principle: ratios scale, absolutes don't.** The only thing we resolve is the *window*; everything else is a
fraction of it:
```
window     = config.contextWindow            // cascade.contextWindow — user override, wins
           ?? provider.contextWindow         // model knowledge lives in the provider (ADR-020)
           ?? 8192                            // safe default
compactAt  = window * compactRatio    (0.80) // trigger when estimated tokens ≥ this
keepRecent = window * keepRecentRatio (0.25) // verbatim recent window for partial compaction
```
- **Window resolution** = override → provider hint → default. Provider hint: OpenAI-compat uses a
  **known-model map** (`gpt-4o`→128k, `gpt-4o-mini`→128k…); Ollama uses **`cascade.numCtx`** (see gotcha) —
  auto-detect via `/api/show` is **deferred** (start with the map + overrides).
- **All overridable** (advanced): `cascade.contextWindow`, `cascade.numCtx`, `cascade.compactRatio`,
  `cascade.keepRecentRatio`. The "output reserve" is implicit in `compactRatio < 1` (no separate buffer).
- **⚠ Ollama `num_ctx` gotcha**: a model's *trained* window ≠ what Ollama uses — it defaults `num_ctx` to ~4k
  unless you pass `options.num_ctx`. So `cascade.numCtx` is the honest knob: we send it in the request AND use
  it as the window. (Detecting `context_length` would *overstate* the usable window.)

### Cascade's compaction design (partial + local-model twist)
We use the **partial** (keep-recent-verbatim) variant — safer than full-replace when re-injection alone could
blow a small budget:
- **Estimate** tokens with a `chars/4` heuristic (no tokenizer dependency; `keepRecent`/`compactAt` are ratios).
- **Tool-output truncation is a separate, earlier layer** (head+tail + a `[…elided]` marker) — run it *before*
  summarizing, since it's the cheapest win.
- `context/compactor.ts → compactIfNeeded(messages, opts)`: if estimated tokens ≥ `compactAt` → split
  `[older, recent]` at the `keepRecent` boundary → ask the model (tool use disabled) for a **structured
  summary** of `older` using a **structured prompt** with fixed headings (load-bearing, model-agnostic; keep the
  `<analysis>`/`<summary>` split) → emit `[summaryMessage, ...recent]` so the loop continues from the summary
  while the raw transcript (and the JSONL trace) stays intact. UI shows a "context compacted" marker.
- **Circuit-breaker** after a few failed attempts (don't hammer the model).
- **Defer**: real tokenizer, `/api/show` auto-detect, microcompaction, hierarchical summaries, RAG recall,
  disk-offload of tool output.

---

## Part 2 — Persistent memory

### The design space
| Approach | Idea | Trade-off |
|---|---|---|
| **File injected into the prompt** ⭐ | a memory file read each session, prepended to the system prompt | transparent, committable, no infra (the common project-instructions file) |
| **Structured KV / JSON** | facts as entries | tidy, but rigid |
| **Vector/semantic memory** | embed + retrieve relevant facts | scales, but needs an embedding store |
| **Tiered self-editing (OS-style)** | core (in-context) + archival (vector, tool-searched) + recall (history); the **agent curates its own memory via tools** | frontier; best when "what to remember" is itself the agent's decision |

### The frontier: tiered self-editing memory ("LLM as an OS")
- **Core memory** = RAM: always in-context (persona + key user/project facts), **self-edited** by the agent.
- **Archival memory** = disk: external vector store, queried via `archival_search` tool calls.
- **Recall memory** = searchable conversation history.
- The agent **moves facts between tiers** with tool calls, and can even run **sleep-time agents** to curate
  memory in the background. This is the best-in-world for *open-ended* memory.

### Is file-injected memory best-in-world?
**For a coding agent's needs (preferences, project facts, conventions), file-injected "core memory" is the
right call** — it's transparent, user-editable, version-controllable (project memory committed with the repo),
and infra-free. It *is* essentially the tiered design's **core memory** tier, file-backed. The frontier adds
**archival + self-editing + background curation** — worth it when memory is large/open-ended, deferrable for us.

### How a mature file-based implementation does it
Memory is a **stack of files**, loaded **lowest→highest priority** (later files weigh more), discovered by
**walking CWD up to the filesystem root** with **closer-to-CWD = higher priority**:

| Tier | Path | Scope |
|---|---|---|
| Managed | a managed-policy instructions file | enterprise policy (always) |
| User | an instructions file in the user's home config dir (+ `rules/*.md`) | global, all projects |
| Project | an instructions file at each level, root→CWD (or in a config subdir) | checked-in |
| Local | a `.local` variant of the project file | private, gitignored |
| Auto-memory | a per-project `MEMORY.md` index in the user's config dir | auto-captured index |

- **Injection**: each file rendered as `Contents of <path>:\n<content>`, prefixed by an **override header**
  (telling the model these instructions take precedence over its defaults and must be followed) and dropped
  into the system prompt. Soft cap ~40k characters (warns, doesn't truncate). Cache invalidated on compaction.
- **`@import`**: files pull in others via `@path` (on leaf text nodes only — skipped in code/comments), with
  a max include depth of 5, circular-ref protection, a text-extension whitelist, and **user approval for
  external** (outside-CWD) imports.
- **Updating** — *no `str_replace` memory tool*; three write paths: (1) a `/memory` command opens
  the file in `$EDITOR`; (2) **auto-extraction** — at the *end* of a completed loop a **forked agent** scans
  the transcript and writes durable facts into the auto-memory dir; (3) hand-edit via normal Edit/Write.
- **Auto-memory index** (`MEMORY.md`, always injected) is capped at 200 lines / 25k bytes, trimmed at a
  newline boundary with a "too long" notice.

### Cascade's design — BEST-IN-CLASS (3 tiers + self-curation, all local)
A file-only design is **file-injected only**: always in-context (capped, costs tokens every turn), **no semantic
retrieval**, and "remembering" is a flat fork-extraction into files. We build the **tiered self-editing
architecture, Ollama-native** — which file-only designs lack — fit for a production-grade product (deep,
retrievable, self-maintaining per-project memory). See ADR-015.

**Tier 1 — Core memory** (always in-context, file-backed): `memory/memoryStore.ts`.
- **Multi-scope**: project `CASCADE.md` + project-local `CASCADE.local.md` (gitignored) + user
  `~/.cascade/CASCADE.md`; **directory walk** CWD→root (monorepos); project/closer = higher priority.
- **`@import`** (`@path`/`@./rel`/`@~/home`): depth cap, text-extension whitelist, circular-ref protection,
  external-import note. Injected under the **OVERRIDE header**, capped by lines+bytes.
- **Structured self-edit tools**: `append` / `replace` / `forget` (not append-only) — tiered-memory-style
  self-curation.

**Tier 2 — Archival memory** ⭐ *(beyond file-only memory)*: `memory/archival.ts`.
- Unbounded store of facts the agent **writes and semantically searches on demand** (`memory_search`,
  `memory_write` tools) — only the relevant facts enter context, so it scales past the always-injected file.
- **Local embeddings via Ollama** (`/api/embeddings`, e.g. `nomic-embed-text`) + cosine similarity; store
  `{id, text, embedding, ts}` in `.cascade/archival.json`. `ModelProvider.embed()` abstracts the backend.

**Tier 3 — Recall**: search past sessions/turns on demand (corpus = the JSONL transcripts we already write).

**Self-curation** ⭐: at the **end of a completed turn**, a focused extraction pass pulls durable facts and
**routes** them — stable preference → core, detailed/contextual → archival. Smarter than flat extraction
(it classifies the tier). (The background sleep-time curation idea, made synchronous + cheap for local.)

**`/memory` overlay**: view / search / edit / forget memory (like the `/mcp` overlay) + write markers.

**Why this is genuinely better than file-only memory:** semantic archival retrieval + tier-routing
self-curation, fully local — capabilities a file-only design does not have.

---

## How they combine (the key insight)
```
system prompt  ──┐
MEMORY (durable) ─┤  ← always injected fresh; NEVER compacted away
SUMMARY block    ─┤  ← older history, compressed
recent N turns   ─┘  ← verbatim, the live working set
```
Memory is the agent's long-term store (survives sessions); the summary is its medium-term store (survives
within a session); recent turns are its short-term store. Compaction only ever touches the middle.

## Lineage
Compaction and file-based memory follow the production coding-agent consensus described above; tiered
self-editing memory is the research frontier we borrow *core-memory* from. Cascade mirrors that consensus,
tuned for small local-model windows.

## Phase 10 build vs defer (summary)
- **Build:** `compactIfNeeded` (chars/4 estimate, tool-output truncation, structured summary, recent-window) ·
  file-backed core memory (project + user) injected into the system prompt · a `Memory` self-edit tool ·
  UI markers. ADR-012 (compaction) + ADR-015 (memory).
- **Defer:** real tokenizer, hierarchical/microcompaction, vector/archival memory, sleep-time curation.
