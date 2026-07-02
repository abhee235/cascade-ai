# Cascade Core — Core Capability & Enhancement Tracker

> **Mission (restated).** Derive a production-grade *agentic algorithm* from scratch — for learning and to
> build something better — tracked ADR-by-ADR like phases 0–13. We have the **common agentic pattern**
> working (loop + tools + basic compaction/permissions/subagents). This doc tracks the **sophisticated**
> parts we have NOT yet captured, plus the core tools we still lack, plus what production-grade versions
> of the big tools do that our 30–40-line versions don't.
>
> **How to use.** This is the single reference for enhancing `@cascade/core`. Pick an item, write its ADR,
> build it, verify, tick the box.

Legend: ☐ not started · ◐ partial · ☑ done. "Target capability" = the behaviour a mature agent core needs.

---

## A. Agentic loop / algorithm gaps

| # | Gap | Cascade today | Target capability | New ADR |
|---|-----|---------------|-------------|---------|
| A1 | ☐ **Streaming tool execution** | tools run only AFTER the full model stream completes ([agentLoop.ts:139‑167](../packages/core/src/agent/agentLoop.ts)) | a streaming tool executor starts a tool **while the model is still streaming** later blocks — overlaps model-time and tool-time | ADR-029 |
| A2 | ☑ **Plan-driven layer stack** | **DONE (ADR-039):** 5 gated layers run cheapest-first — `collapse` (dedupe superseded reads/searches) → `mask` (size-gated) → `microcompact` (evict compactable tool results) → `snip` (reclaim large tool *inputs*) → `summarize` (LLM); thresholds derive from the model profile (ADR-038). Also reclaims tool *inputs* (Write/Edit bodies) + fully automatic. ([compactionLayers.ts](../packages/core/src/context/compactionLayers.ts), [compactor.ts](../packages/core/src/context/compactor.ts)) | 5 layers: **tool-result budget → snip → microcompact → context-collapse → autocompact** | ADR-039 ✅ (defer: fresh-context mode, CJK est.) |
| A3 | ◐ **Recovery depth** | retry/backoff + overflow→compact ([resilience.ts](../packages/core/src/llm/resilience.ts)) | + **token escalation** (raise `max_tokens` on truncation) + **budget continuation** | ADR-031 |
| A4 | ☑ **Read-before-Edit freshness** | **DONE (ADR-032):** session-scoped `FileStateCache`; Edit refuses unread/stale files (mtime + content fallback), CRLF-normalized | `readFileState` map: Edit **refuses** a file not Read first, or changed since read | ADR-032 ✅ |
| A5 | ◐ **Permission depth** | rules match by **tool name only**; Bash is one opaque allow/deny ([gate.ts:38](../packages/core/src/permissions/gate.ts)) | input-aware rules (`Bash(npm run test:*)`, `Edit(src/**)`), a **bash command classifier** (split `a && b \| c`, gate each), and **hooks** | ADR-035 (rules), ADR-036 (hooks) |
| A6 | ◐ **Prompt & context engineering** | **DONE (ADR-037):** tier-aware sectioned system prompt (`minimal`/`lean`/`full` by window) — the behavioural core (read-before-edit, verify-before-done, report-faithfully, tool discipline, tone) weak models can't infer; 128k→full, adaptive. ([systemPrompt.ts](../packages/core/src/agent/systemPrompt.ts)) · **defer:** per-tool prompts, subagent prompt, git/dir context injection | rich tone/conventions prompt + **context gathering** (instruction files, directory structure, git status injected) + static/dynamic **cache boundary** | ADR-037 ✅ |
| A7 | ☐ **Cost / token accounting** | JSONL tracer only ([tracer.ts](../packages/core/src/observability/tracer.ts)) | per-turn token + cost tracking | ADR-040 |
| A9 | ☑ **Durable todo checklist + reminder** | **DONE (ADR-034):** session `TodoStore` persisted to `.cascade/todos.json`; state-aware `<system-reminder>` re-injected when the model drifts; one-in_progress invariant enforced | a todo list in app state + a re-injected reminder (turns since last use) | ADR-034 ✅ |
| A8 | ☑ **Filesystem confinement (host ↔ sandbox)** | **DONE (ADR-033):** `resolveInProject` jails every file tool to the project root; `/app`·`/workspace` aliases re-root, escapes rejected; `Sandbox.root` + prompt show one coherent cwd | file tools confined via input validation + permission deny-rules + path expansion | ADR-033 ✅ |

> **ADR numbering key.** Two cross-cutting ADRs sit outside the A-list: **ADR-038** = model-capability profile →
> adaptive budgets; **ADR-039** = plan-driven layered compactor (consumes ADR-038; delivers A2). A7 uses ADR-040.

---

## B. Core tools — coverage

Cascade has: `Read, Write, Edit, Bash, Glob, Grep, Memory, MemorySearch, Subagent`.

| Core tool | Purpose | Priority for Cascade | Status |
|-----------|---------|----------------------|--------|
| **Todo list** (`TodoWrite`) | the agent maintains a live task list (plan & track multi-step work) | **HIGH** — big agent-quality win | ☑ done — tool + one live list (web + extension); **+ ADR-034: durable `TodoStore` (persisted to `.cascade/todos.json`, survives compaction/restart), state-aware periodic reminder, enforced one-in_progress invariant** — goes past an in-memory list + static nag |
| **MultiEdit** *(multi-edit mode of Edit)* | several edits to one file atomically | **HIGH** | ☐ |
| **Web fetch** / **web search** | fetch a URL / web search | MED (needs network; optional for offline) | ☐ |
| **EnterPlanModeTool** / **ExitPlanModeTool** | present a plan, get approval before acting | MED (we have `plan` permission mode, no flow) | ☐ |
| **AskUserQuestionTool** | structured multiple-choice question to the user | MED | ☐ |
| **TaskCreate/Get/List/Update/Output/Stop** | background tasks / async sub-agents | MED (pairs with background Bash) | ☐ |
| **Agent teams + messaging** | multi-agent coordination + messaging | LOW (after subagents mature) | ☐ |
| **SkillTool** | invoke a packaged skill | MED | ☐ |
| **Notebook editing** | edit Jupyter cells | LOW (niche) | ☐ |
| **LSPTool** | language-server diagnostics/hover | MED (great for a code builder) | ☐ |
| **MCP resources** (list / read) + **MCP auth** | MCP resources (beyond MCP tools) | MED | ☐ |
| **Tool search** | search/deferred-load a large tool catalog | LOW | ☐ |
| **Specialized** — sleep, cron scheduling, remote triggers, REPL, PowerShell, workflows, briefs, config, git worktrees | specialized / host-specific | LOW / skip | ☐ |

---

## C. Per-tool sophistication — "why theirs is 300–400 lines and ours is 30–40"

Each is a checklist of behaviours to port into our tool. (Cascade line counts in headers.)

### C1. Read — Cascade **41** lines
- ☐ **Image files** → return as a multimodal image block; resize/downsample to a token budget
- ☐ **PDF files** → page-count, page-range parsing, extract pages, size thresholds
- ☐ **Jupyter notebooks** → map cells (+ outputs) to a readable result
- ☐ **Binary detection** → don't dump binary; report it (binary-extension check)
- ☑ **offset / limit** params for partial reads of huge files (ADR-032)
- ☑ **Size cap** with a "read it in parts with offset/limit" error instead of silent truncation (ADR-032)
- ☑ **Line-number formatting** (`␣␣␣␣␣1→…`, cat -n style) the model relies on for Edit (ADR-032)
- ☑ **Record freshness** in `readFileState` (content + mtime) so Edit can require it (ADR-032)
- ☑ **CRLF→LF normalization** of returned content (so the model's view matches Edit's matching) (ADR-032)
- ☐ macOS screenshot path quirks (thin-space before AM/PM) — *skip, host-specific*

### C2. Edit — Cascade **45** lines
- ☑ **Freshness guard**: read `readFileState`, error if the file wasn't Read or changed since (ADR-032)
- ☐ **Encoding detection** from the byte buffer (not assume utf8 / UTF-16 BOM)
- ☑ **CRLF↔LF normalization** before matching (`replaceAll('\r\n','\n')`) (ADR-032)
- ☐ **replace_all** flag (we only do single-occurrence)
- ☑ uniqueness error when `>1` match and not replace_all (we have this)
- ☑ **Path normalization** (`resolve()`) for the freshness lookup (ADR-032)
- ☐ **Settings-file validation** (refuse edits that would corrupt config) — *adapt to our context*

### C3. Write — Cascade **46** lines
- ☐ Freshness/overwrite guard (don't blind-overwrite a file the agent hasn't seen)
- ☐ Encoding + line-ending preservation
- ☐ Parent-dir creation, large-content handling, diff preview in the result

### C4. Bash — Cascade **74** lines
- ☐ **Background tasks**: auto-background a long command after N ms; background-output / kill-shell equivalents
- ☐ **Command-prefix permissions**: parse the command, extract a prefix, wildcard-match rules — feeds A5
- ☐ **cd / multi-command awareness** (does the command contain any `cd`?), reset cwd if it escapes the project
- ☐ **Timeout** (default + max) with a clean kill
- ☐ **Output truncation** that keeps the tail + per-line truncation
- ☐ **Git operation tracking** (notice commits/branch changes)
- ☐ **Image output** from a command (e.g., a screenshot) → multimodal result
- ☐ Sandbox decision (should this command be sandboxed?) — *we already sandbox via Docker; align the policy*

### C5. Grep — Cascade **57** / Glob — Cascade **35**
- ☐ ripgrep-backed with output modes (`content` / `files_with_matches` / `count`), context lines (`-A/-B/-C`), globs, multiline, head-limit
- ☐ result truncation + "N more matches" affordances

---

## Suggested build order

1. **A4 + C2 freshness** and **C1 Read** sophistication (Read-before-Edit is foundational and small).
2. **A1 streaming tool execution** (the signature loop behaviour).
3. **A5 permission depth** (input-aware rules + bash classifier) then **A2 compaction stack**.
4. **TodoWriteTool** + **MultiEdit** (high agent-quality, low risk).
5. Everything else as appetite allows.

> Each item = one ADR (`docs/adr/ADR-0XX-*.md`) + a short phase note, built and verified against the two
> test-query discipline, exactly as phases 0–13. Update the checkboxes here as we go.
