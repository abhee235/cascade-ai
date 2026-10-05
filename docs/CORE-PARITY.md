# Cascade Core — Core Capability & Enhancement Tracker

> **Mission (restated).** Derive a production-grade *agentic algorithm* from scratch — for learning and to
> build something better — tracked ADR-by-ADR like phases 0–13. We have the **common agentic pattern**
> working (loop + tools + basic compaction/permissions/subagents). This doc tracks the **sophisticated**
> parts we have NOT yet captured, plus the core tools we still lack, plus what production-grade versions
> of the big tools do that our 30–40-line versions don't.
>
> **How to use.** This is the single reference for enhancing `@cascade/core`. Pick an item, write its ADR,
> build it, verify, tick the box.
>
> **Eval delta (PLAN-eval E5).** Any ADR touching loop/prompt/compaction/tool behaviour carries a before/after
> eval line: `npm run eval -- --model <m> --label <adr>-after`, then
> `npm run eval:report -- --diff <baseline> <adr>-after` (exit 1 = regression). Baselines: `docs/EVAL-BASELINE.md`.

Legend: ☐ not started · ◐ partial · ☑ done. "Target capability" = the behaviour a mature agent core needs.

---

## A. Agentic loop / algorithm gaps

| # | Gap | Cascade today | Target capability | New ADR |
|---|-----|---------------|-------------------|---------|
| A1 | ☐ **Streaming tool execution** | tools run only AFTER the full model stream completes ([agentLoop.ts:139‑167](../packages/core/src/agent/agentLoop.ts)) | a streaming tool executor starts a tool **while the model is still streaming** later blocks — overlaps model-time and tool-time | ADR-029 |
| A2 | ☑ **Plan-driven layer stack** | **DONE (ADR-039):** 5 gated layers run cheapest-first — `collapse` (dedupe superseded reads/searches) → `mask` (size-gated) → `microcompact` (evict compactable tool results) → `snip` (reclaim large tool *inputs*) → `summarize` (LLM); thresholds derive from the model profile (ADR-038). Also reclaims tool *inputs* (Write/Edit bodies) + fully automatic. ([compactionLayers.ts](../packages/core/src/context/compactionLayers.ts), [compactor.ts](../packages/core/src/context/compactor.ts)) | 5 layers: **tool-result budget → snip → microcompact → context-collapse → autocompact** | ADR-039 ✅ (defer: fresh-context mode, CJK est.) |
| A3 | ◐ **Recovery depth** | retry/backoff + overflow→compact ([resilience.ts](../packages/core/src/llm/resilience.ts)) | + **token escalation** (raise `max_tokens` on truncation) + **budget continuation** | ADR-031 |
| A4 | ☑ **Read-before-Edit freshness** | **DONE (ADR-032):** session-scoped `FileStateCache`; Edit refuses unread/stale files (mtime + content fallback), CRLF-normalized | a read-state map: Edit **refuses** a file not Read first, or changed since read | ADR-032 ✅ |
| A5 | ☑ **Permission depth** | **Hooks half DONE (ADR-036):** .cascade/hooks.json → PreToolUse (exit-2 blocks with model-visible stderr; JSON permissionDecision allow|deny|ask; tool-name matcher semantics; deny wins; 30s tree-killed timeout; fail-open on errors) + PostToolUse (exit-2 stderr appended to the tool_result — lint-and-make-the-model-fix-it). Wired at the scheduler gate. **Rules half DONE (ADR-035):** input-aware rules (Bash exact/:* prefix, file globs) + quote-aware bash classifier (compound = least-trusted segment; subshells opaque); deny-beats-bypass; allow-always learns exact segments ([hookRunner.ts](../packages/core/src/hooks/hookRunner.ts)) | input-aware rules, bash classifier, and hooks | ADR-035 ✅ · ADR-036 ✅ — **A5 CLOSED** |
| A6 | ◐ **Prompt & context engineering** | **DONE (ADR-037):** tier-aware sectioned system prompt (`minimal`/`lean`/`full` by window) — the behavioural core (read-before-edit, verify-before-done, report-faithfully, tool discipline, tone) weak models can't infer; 128k→full, adaptive (rather than one prompt for every model). ([systemPrompt.ts](../packages/core/src/agent/systemPrompt.ts)) · **+ context gathering DONE (ADR-046):** bounded tier-sized **directory tree** + **git status** snapshot gathered once/session ([projectContext.ts](../packages/core/src/agent/projectContext.ts)), injected into the system prompt (never compacted); **AGENTS.md** / other agents' instruction-file interop in memory loading (CASCADE.md was already injected) · **defer:** per-tool prompts, subagent prompt | rich tone/conventions prompt + **context gathering** (project instruction file, directory structure, git status injected) + static/dynamic **cache boundary** | ADR-037 ✅ · ADR-046 ✅ |
| A7 | ◐ **Cost / token accounting** | **Trace layer DONE (ADR-040):** backend usage (`prompt_eval_count`/`usage`) captured per model call → `model_response.usage` trace event; `compaction {kind, tokensBefore/After, forced}` trace events; `temperature` passthrough for eval determinism. **Defer:** session totals, UI display, pricing | per-turn token + cost tracking | ADR-040 ◐ |
| A9 | ☑ **Durable todo checklist + reminder** | **DONE (ADR-034):** session `TodoStore` persisted to `.cascade/todos.json`; state-aware `<system-reminder>` re-injected when the model drifts; one-in_progress invariant enforced | session todo state + a reminder re-injected based on turns since the last update | ADR-034 ✅ |
| A8 | ☑ **Filesystem confinement (host ↔ sandbox)** | **DONE (ADR-033):** `resolveInProject` jails every file tool to the project root; `/app`·`/workspace` aliases re-root, escapes rejected; `Sandbox.root` + prompt show one coherent cwd | file tools confined via input validation + permission deny-rules + path expansion | ADR-033 ✅ |

> **ADR numbering key.** Two cross-cutting ADRs sit outside the A-list: **ADR-038** = model-capability profile →
> adaptive budgets; **ADR-039** = plan-driven layered compactor (consumes ADR-038; delivers A2). A7 uses ADR-040.

---

## B. Core tools — coverage

Cascade has: `Read, Write, Edit, MultiEdit, Bash, Glob, Grep, TodoWrite, Lsp, AskUserQuestion, EnterPlanMode, ExitPlanMode, Memory, MemorySearch, Subagent`.

| Core tool | Purpose | Priority for Cascade | Status |
|-----------|---------|----------------------|--------|
| **Todo list** (`TodoWrite`) | the agent maintains a live task list (plan & track multi-step work) | **HIGH** — big agent-quality win | ☑ done — tool + one live list (web + extension); **+ ADR-034: durable `TodoStore` (persisted to `.cascade/todos.json`, survives compaction/restart), state-aware periodic reminder, enforced one-in_progress invariant** — goes past an in-memory list + static nag |
| **MultiEdit** *(multi-edit mode of Edit)* | several edits to one file atomically | **HIGH** | ☑ done (ADR-042) — atomic sequential edits + collision guard + replace_all; shares ADR-032 freshness with Edit via `editCore.ts`; `$`-literal fix. Pairs with `Lsp references` for rename |
| **Web fetch** / **web search** | fetch a URL / web search | MED (needs network; optional for offline) | ☐ |
| **Plan mode** (enter / exit) | present a plan, get approval before acting | MED (we have `plan` permission mode, no flow) | ☑ done (ADR-044) — Enter switches to `plan` mode (writes denied, plan-specific message); Exit presents the plan via the AskUserQuestion round-trip → **Approve/Revise** in the QuestionCard → restores the *prior* mode (bypass-safe). No new UI |
| **Ask-user question** | structured multiple-choice question to the user | MED | ☑ done (ADR-043) — tool + scheduler park + `respondQuestion` round-trip + **web QuestionCard** (live-verified in browser) + tier-sized description + "ask only when blocked" nudge; generalized to also drive ExitPlanMode |
| **Background tasks** (create / get / list / update / output / stop) | background tasks / async sub-agents | MED (pairs with background Bash) | ☐ |
| **Agent teams + messaging** | multi-agent coordination + messaging | LOW (after subagents mature) | ☐ |
| **Skill invocation** | invoke a packaged skill | MED | ☐ |
| **Notebook editing** | edit Jupyter cells | LOW (niche) | ☐ |
| **Language server** | language-server diagnostics/hover | MED (great for a code builder) | ☑ done (ADR-041) — `Lsp` tool: real TS `LanguageService` (diagnostics/definition/references/hover); diagnostics route to sandbox `tsc`. TS/JS only |
| **MCP resources** (list / read) + **MCP auth** | MCP resources (beyond MCP tools) | MED | ☐ |
| **Tool search** | search/deferred-load a large tool catalog | LOW | ☐ |
| **Specialized** — sleep, cron scheduling, remote triggers, REPL, PowerShell, workflows, briefs, config, git worktrees | specialized / host-specific | LOW / skip | ☐ |

---

## C. Per-tool sophistication — what a production-grade tool does that a 30–40-line one doesn't

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

### C4. Bash — Cascade **74→~185** lines — ◐ hardened (ADR-045)
- ☐ **Background tasks**: auto-background a long command after N ms; background-output / kill-shell equivalents — *deferred (ADR-045): preview system already runs the dev server; finite commands covered by timeout*
- ☐ **Command-prefix permissions**: parse the command, extract a prefix, wildcard-match rules — feeds A5
- ☐ **cd / multi-command awareness** (does the command contain any `cd`?), reset cwd if it escapes the project
- ☑ **Timeout** (default 120s + max 600s) with a clean kill — **ADR-045**: one AbortController (timer OR Stop) drives host+sandbox; actionable "rerun with a larger timeout" result (self-corrects, no background needed)
- ☑ **Output truncation** — **ADR-045**: `BoundedOutput` keeps **head + tail** (rather than head-only; the failure summary is at the end) + per-line cap; bounded memory on any size
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
4. **TodoWrite** + **MultiEdit** (high agent-quality, low risk).
5. Everything else as appetite allows.

> Each item = one ADR (`docs/adr/ADR-0XX-*.md`) + a short phase note, built and verified against the two
> test-query discipline, exactly as phases 0–13. Update the checkboxes here as we go.
