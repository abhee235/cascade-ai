# Learning: tool faculties — why an agent needs *these* tools, and how the loop orchestrates them

## Q: A full-featured coding agent has ~40 tools. Is that a random pile? How do I decide what Cascade needs?

No — it's not a pile. Every tool maps onto one **faculty** an autonomous worker needs. Once you see the
faculties, the roster stops looking like buzzword soup and becomes a checklist you can prioritise for a
*weak-model* harness (our goal).

The faculties, in the order they fire in a real task:

> **Perceive → Decide/Plan → Act → Verify → Communicate → Delegate → Persist across time**

A tool is the **only** way the model touches the world (it just emits text + structured tool requests; the
harness runs them — see [[tool-call-binding]]). So the *set* of tools is the agent's entire range of
action. This note is the conceptual map; **status/priority of each gap lives in the tracker**
(`docs/CORE-PARITY.md` §B), not here — don't duplicate the checkboxes.

---

## The faculties → tools (and *why* each exists)

Each tool's description (what the model actually sees) says when to use it; the roster is assembled in one
place and advertised each turn.

### A. Perceive — read-only "senses" (side-effect-free ⇒ safe to run in parallel)
| Tool | Why it exists |
|---|---|
| **Read** | Pull a file into context — also images, PDFs, notebooks (multimodal). The atom of "look at code." |
| **Glob** | Find files *by name/path pattern*, fast, at any repo size. "Where is the file?" |
| **Grep** | Find files *by content* (ripgrep + regex). Prompt **forbids** raw `grep`/`rg` via Bash — the dedicated tool has correct permissions + structured output. |
| **LSP** | *Semantic* intelligence, not text: go-to-definition, find-references, call hierarchy. "The actual definition and everyone who calls it" vs "lines containing `foo`". |
| **WebFetch** | Retrieve a URL → markdown → summarise via a small model. Reach beyond the repo. |
| **WebSearch** | Information past the knowledge cutoff; mandates a Sources section. |
| **ListMcpResources / ReadMcpResource** | Read data exposed by MCP servers (faculty F). |
| **ToolSearch** | Discover *deferred* tools when too many to fit the prompt (faculty F). |

Unifying property: **none mutate state**, so the scheduler fires a whole batch concurrently.

### B. Act — "hands" (side effects ⇒ gated + serialized)
| Tool | Why it exists |
|---|---|
| **Edit** | Exact string replacement — the *surgical* change, sends only the diff. **Requires a prior Read** (read-before-edit invariant; our ADR-032). |
| **Write** | Create / full-rewrite a file. Also Read-first if it exists. Prompt steers toward Edit. |
| **NotebookEdit** | Cell-level `.ipynb` edits — notebooks are JSON, a normal Edit would corrupt them. |
| **Bash / PowerShell** | Run any shell command — build, test, git, install. The universal escape hatch ([[tool-granularity]]). |

The dangerous ones: pass the permission gate, run **serially** (writes race; reads don't).

### C. Decide / Plan — executive function
| Tool | Why it exists |
|---|---|
| **TodoWrite** | Lightweight in-session checklist. Fights weak-model **drift and early exit**: "exactly one in_progress," "mark done immediately," "never done if tests fail." Attention management *as a tool*. |
| **TaskCreate / Get / Update / List** | "Todo v2" — *persistent* tasks with dependencies (`blocks`/`blockedBy`) and **owners** (hand work to teammates). TodoWrite is a sticky note; this is a project tracker. |
| **EnterPlanMode** | Flip into a **read-only design phase** for non-trivial work — explore, don't mutate, propose an approach. |
| **ExitPlanMode** | The **approval gate**: mutation stays blocked until the human approves the plan file. |

### D. Act-at-scale — delegation (protects the main context window)
| Tool | Why it exists |
|---|---|
| **Agent** | Spawn a sub-agent (or *fork*). Key trick: it does noisy work in *its own* context and returns **only the conclusion** → main window stays clean. Supports background / worktree / remote isolation. |
| **SendMessage** | Resume an existing agent *with its context intact* (a fresh `Agent` call starts cold). |
| **TeamCreate / TeamDelete** | Manage agent *swarms*. |
| **TaskStop / TaskOutput** | Control async work — stop it, fetch its output. |
| **Skill** | Invoke a *packaged procedure* (slash command/skill) — reuse a vetted workflow instead of re-deriving steps. |

### E. Communicate — human-in-the-loop
| Tool | Why it exists |
|---|---|
| **AskUserQuestion** | Structured multiple-choice to resolve ambiguity *mid-task* without stopping. Clarifies *specifics*; plan approval goes through ExitPlanMode. |
| **SendUserMessage** (a.k.a. Brief) | The channel the user **actually reads**. Its prompt is blunt: plain text outside this tool is assumed *unread* — the real answer must go through here. `status: proactive` flags agent-initiated messages. |

### F. Connectivity & tool-sprawl management
| Tool | Why it exists |
|---|---|
| **MCP tools** (dynamic) + **McpAuth** | Plug in external systems (GitHub, Sentry, DBs, browsers) without rebuilding the harness. MCP = the USB-C port for tools (see [[mcp-init-strategy]]). |
| **ToolSearch** | When too many tools exist, their schemas blow the context budget → tools are **deferred** (names only) and schemas fetched on demand. |

### G. Persist across time — autonomy (feature-gated "proactive" surface)
| Tool | Why it exists |
|---|---|
| **Sleep / Cron / Monitor / RemoteTrigger / SubscribePR / PushNotification / SuggestBackgroundPR** | Pause, schedule, watch a condition, wake on an external event, reach the user when away. These turn a *request-response* agent into one that **operates across time** — the leap from chatbot to coworker. |

### H. Environment isolation
| **EnterWorktree / ExitWorktree** | Work on an isolated git worktree so experiments don't touch the main tree. |

---

## How the loop *organises* the faculties (not arbitrary firing)

This maps directly onto our `agentLoop.ts` + `scheduler.ts`:

1. **Advertise** — each turn the model is sent the available tool *schemas* (or deferred names + ToolSearch).
2. **Model emits tool calls** (faculty A/B/…) or finishes (no tool_use ⇒ terminal — see [[agentic-loop]]).
3. **Gate** — each call passes the permission check *before* running (`scheduler.ts` `checkPermission`). Reads auto-allow; writes/Bash may prompt ([[permissions-vs-sandbox]]).
4. **Schedule by safety** — consecutive **read-only tools run in parallel**; any **mutating tool runs solo/serial** (correctness: reads can't interfere, writes can race — our `partition()`).
5. **Mode restricts the toolset** — in **plan mode**, mutating tools are *removed entirely*; only Perceive + Plan tools are offered. That's how "read-only design phase" is *enforced*, not merely requested.
6. **Results feed back** into context; loop repeats.
7. **Delegation isolates context** — an **Agent** call runs a nested loop with its *own* window and returns only its final message (our `spawnSubagent`, [[resilience-and-subagents-design]]).

So the faculties aren't just a taxonomy — they correspond to **how the scheduler treats each tool**
(parallel vs serial, gated vs free, allowed vs hidden-by-mode).

---

## Two scenarios to visualise the whole surface

### Scenario 1 — "Build a feature" (the inward loop)
> *"Add rate limiting to our API. Make sure tests pass, then open a PR."*

| Loop phase | Tool(s) | Why here |
|---|---|---|
| Decide | **EnterPlanMode** | Multiple valid approaches (token bucket vs sliding window vs Redis) → sign-off first. Mutating tools now hidden. |
| Perceive (parallel) | **Glob + Grep + Read** | Find the API layer, search middleware, read the router — read-only ⇒ one batch. |
| Perceive (semantic) | **LSP** findReferences | "Who calls `registerRoute`?" — text search isn't enough. |
| Decide (clarify) | **AskUserQuestion** | "In-memory or Redis-backed?" — a fork only the user can pick. |
| Decide (submit) | **ExitPlanMode** | Plan written → request approval. Mutation unlocks only after "yes." |
| Organise | **TaskCreate / TodoWrite** | Track: add middleware, wire config, write tests, run suite. |
| Act (serial) | **Write** → **Edit** | New middleware file; surgical edit into the router. Each needed a prior Read. |
| Verify | **Bash / PowerShell** | `npm test`. Red ⇒ task stays in_progress, fix, re-run. |
| Delegate | **Agent** (code-reviewer, background) | Independent review in its own context; keep working; notification returns later. |
| Persist | **Skill** (`/commit-push-pr`) | Reuse the vetted commit+PR procedure. |
| Communicate | **SendUserMessage** | "Shipped, tests green, PR #142" — the message they actually read. |

### Scenario 2 — "Investigate an incident + stand watch" (the outward + temporal loop)
> *"Error rates spiked on checkout after this morning's deploy. Figure it out, and keep an eye on it."*

| Loop phase | Tool(s) | Why here |
|---|---|---|
| Connect | **ToolSearch** | Sentry/GitHub MCP tools are deferred — fetch schemas first. |
| Connect | **McpAuth + ListMcpResources / ReadMcpResource** | Auth to the observability server; pull error events + traces. |
| Perceive (external) | **WebSearch → WebFetch** | Trace cites a library bug; search it, fetch the GitHub issue for the fix. |
| Perceive (deep) | **Grep (multiline) + LSP** incomingCalls | Locate the failing function and trace *who* calls it. |
| Perceive (history) | **Bash** (`git log`, `gh pr view`) | Identify the morning's deploy commit/PR. |
| Analyse data | **NotebookEdit + Bash** | A quick `.ipynb` charting error-rate-over-time from exported logs. |
| Isolate | **EnterWorktree** → Edit/Bash → **ExitWorktree** | Reproduce + test a candidate fix without disturbing the main tree. |
| Delegate (parallel) | **Agent ×2** (background) | One drafts the hotfix; one maps blast radius. Independent ⇒ launched together. |
| Persist across time | **Monitor / Cron / RemoteTrigger** | "Keep an eye on it": watch until normal / schedule checks / wake on a webhook. |
| Reach the user | **PushNotification** | They're away — ping when the threshold trips or the fix is ready. |
| Resume | **SendMessage** | The hotfix agent reports back; continue *it* (context intact) for review comments. |
| Control async | **TaskOutput / TaskStop** | Pull findings; stop the monitor once resolved. |
| Communicate | **SendUserMessage** (`status: proactive`) | Agent-initiated summary: root cause, hotfix PR, baseline restored. |

**Why two:** Scenario 1 exercises the planning/file/execution/delegation core that fires on almost every
coding request. Scenario 2 mops up the tools that *only* appear when you reach **external** systems (MCP,
web) or operate **across time** (monitor/cron/triggers/notifications) — the ones that make the agent feel
like a teammate. Together they hit ~every tool.

---

## How Cascade mirrors / defers this

**Builtins today (10):** `Read, Write, Edit, Bash, Glob, Grep, Memory, MemorySearch, Subagent, TodoWrite`
(+ MCP tools loaded dynamically into the registry).

Mapped to faculties:

| Faculty | Cascade has | Cascade lacks (→ see CORE-PARITY §B for status) |
|---|---|---|
| **A. Perceive** | Read, Glob, Grep, MemorySearch (recall) | LSP (semantic), WebFetch/WebSearch (external), MCP resource reads |
| **B. Act** | Write, Edit, Bash | MultiEdit, NotebookEdit |
| **C. Decide/Plan** | TodoWrite | **Plan-mode flow** (we have a `plan` permission *mode* but no Enter/Exit flow) |
| **D. Delegate** | Subagent (nested loop, returns summary) | SendMessage (resume), background tasks (TaskCreate/Stop/Output), Skill |
| **E. Communicate** | — (replies via text/`ActivityEvent`) | AskUserQuestion, a real user-message channel |
| **F. Connectivity** | MCP **tools** | MCP **resources**, ToolSearch (deferred catalog) |
| **G. Time/autonomy** | — | Sleep/Cron/Monitor/RemoteTrigger/PushNotification |
| **H. Isolation** | sandbox (ADR-033) | git worktrees |

**Priority for a weak-model harness** (ties back to the harness-engineering discussion): the faculties weak
models need *most* are **C (executive function)** and **D (delegation)** — they keep a weak model on-track
and keep its context clean, which it needs more than a frontier model does. We already have TodoWrite (C)
and Subagent (D); the highest-leverage next steps are the **plan-mode flow** (C) and **AskUserQuestion**
(E, so the model asks instead of guessing). Reliability of tool *calls* themselves (prose-fallback + JSON
repair) is a separate axis tracked in [[model-capability-fallbacks]].

## References
- Orchestration in Cascade: `packages/core/src/agent/agentLoop.ts`, `packages/core/src/tools/scheduler.ts`
