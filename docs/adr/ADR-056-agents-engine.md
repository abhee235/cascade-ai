# ADR-056 — Named agents: file-defined personas for delegation (planner first)

> **Status:** accepted 2026-07-06 (user: "agents are like skills but used differently — e.g. the builder
> should always PLAN first via a planner.md, maybe ask the user about db/auth/backend"). Implementing.

## Context

File-defined agents (a directory of `agents/*.md` definitions) are the established
delegation twin of skills: frontmatter (`agentType`, `whenToUse`, `tools` allowlist, `model`,
`maxTurns`, `skills` to preload…) + a markdown BODY that becomes the spawned agent's OWN system prompt.
**Skills change how the current agent works; agents change WHO does the work** — a fresh context, its
own persona and tool permissions, only the final report returns. Cascade has the mechanics (Subagent →
nested loop) but only anonymous errand-runners: no personas, no per-agent tool policy, nothing a user
can define.

## Decision

Same engine pattern as ADR-055, reusing its loader conventions:

1. **`AgentDef`** — frontmatter: `name`, `description` (the when-to-use line advertised to the main
   model), `tools` (allowlist for the child registry), `maxTurns`, `skills` (names whose BODIES are
   preloaded into the child's system prompt — born knowing the recipes), `interactive` (reserved, v1.1);
   body = the child's system prompt (REPLACES the parent's extraInstructions — a planner must not
   inherit builder-behavior).
2. **Loading & shadowing** — `agentDirs` session option, base dirs first (server-owned, immutable,
   outside the Read jail) then project `.cascade/agents/` (user's own; shadow by name).
3. **Spawning** — Subagent tool gains `agent?: string`. The loop resolves the def: child gets the def's
   system prompt, a registry filtered to its allowlist, its maxTurns, preloaded skills. Unknown name →
   error listing available agents (self-correction). The system prompt gains an Agents index line-per-
   agent (like the skills index) so the main model knows who it can delegate to.
4. **The builder's planner flow (first pack + measured scenario):** BUILDER_BEHAVIOR: for a NEW app or
   major feature — (a) the MAIN agent asks up to 3 clarifying questions (AskUserQuestion: persistence?
   auth? key views?), (b) spawns `planner` with the request + answers, (c) planner (tools: Read, Glob,
   Grep, Skill, Write; skills: architecture preloaded) writes `PLAN.md` — pages, data model, components,
   out-of-scope — and reports a summary, (d) the builder implements AGAINST the plan; later feature
   rounds re-read it for consistency.

## Deliberate v1 choices

- **Children still cannot ask the user.** The user's clarify-step runs in the MAIN loop (it owns the
  question channel). v1.1 design noted: session.submit becomes a merged stream (loop events + a
  side-channel) so `interactive: true` agents can surface question cards from inside a spawn — until
  then the flag is parsed but inert.
- No per-agent model/effort overrides (single local model today), no plugin agents, no agent memory.

## Rung 2 — plan-first detect→remind (added 2026-07-07, measured)

skills-2 measured the v1 prompt flow: **zero planner spawns in both scenarios** while the simple
MANDATORY-SKILLS rule was obeyed perfectly. Same lesson as the verify gate and the todo reminder: a
3-step composite instruction loses to a mechanical mandate on weak models. So the harness detects
instead — successful Write/Edit at depth 0, no `PLAN.md` in cwd, planner never spawned → inject the
EXACT `Subagent {agent: "planner", prompt: …}` directive once per submit (`plan_nudge` trace event).

**Activation lives in the capability's own frontmatter, not session config.** First cut was a
`planFirst: true` session flag; the user challenged it as overfitting (the flag was perfectly
correlated with mounting the planner dir — zero independent information, and the two could drift:
flag on without a planner = nudge names a nonexistent agent). Second cut — bare presence — overshot
the other way: established agent engines never treat an agent's existence as enforcement. The shipped
design is the established idiom made deterministic: proactive use is declared **in the agent's own
definition** (by convention, an agent whose description says to use it proactively is used proactively;
skills likewise carry a disable-model-invocation flag in their own frontmatter). `planner.md` declares
`proactive: true`; the nudge arms only for a mounted planner that declares it. Presence = available;
frontmatter = enforced. Users silence it by shadowing `planner.md` without the field.

## Rung 3 — the deterministic plan stage (added 2026-07-07, measured)

planner-1 measured rung 2 live: the nudge fired on cue at turn 2 and qwen36 **read it, reasoned about
it, and declined** — "this is a straightforward storefront… I have all the information I need" — then
built successfully anyway. Verdict: a reminder has no teeth, and for one-shot builds the model's call
was arguably right. But the builder product wants planning on every fresh project (the plan is what
survives compaction across iterate rounds), and polite requests demonstrably don't deliver that.

So the builder ORCHESTRATES, the way hosted builders do — planning is a pipeline stage the model never votes
on. On the FIRST message of a fresh project (no PLAN.md, empty history, proactive planner mounted), the
server runs the planner as its OWN TOP-LEVEL session (`planStage.ts`: def body = system prompt, def
tools = a session-level allowlist, skills preloaded); only after it finishes does the builder session
see the user's message. Deliberate consequences:

- **The clarify step finally works.** A top-level planner owns the question channel — its
  AskUserQuestion cards flow to the real user over the same WS pipe (the v1 "children can't ask"
  limitation is bypassed, not solved; Subagent-spawned planners still can't ask and the persona says
  to plan from the prompt alone in that case).
- **Core stays policy-free.** Enforcement lives in `packages/server` (planStage.ts + the wsServer
  submit path). Core only gained generic mechanisms: `SessionOptions.tools` (a session-level allowlist,
  the same filter the Subagent path applies) and public exports for the def/skill loaders.
- **Graceful degradation, never a deadlock.** If the planner fails to produce PLAN.md, the builder
  proceeds anyway — rung 2's nudge remains as the in-session safety net. Abort during the stage
  cancels the WHOLE submit (the builder must not start after the user said stop).
- The old 3-step PLAN FIRST prompt rule shrank to what orchestration can't see: stay consistent with
  PLAN.md later, and update it via `Subagent {agent: "planner"}` for major features.

## Rung 4 — argument-scoped tool grants: the capability wall (added 2026-07-09, measured)

Rung 3 orchestrated WHEN the planner runs but not WHAT it can do, and two runs exposed the gap. In
planner-2 the planner built 6 files because the preloaded `architecture` skill's imperative checklist
got executed; removing the preload (planner-3) didn't help — the planner *still* built, now a 295-line
monolith, and never wrote PLAN.md, despite a system prompt that said "you write EXACTLY ONE file." The
lesson is blunt: **a system-prompt persona cannot stop a mid-size model from building when it holds an
unrestricted Write and receives a build request** — the concrete task beats the abstract role every
time.

Industry check (the plan modes of hosted app builders): production plan-vs-build tools enforce the split
by *removing the code-write capability* in the planning phase, never by prompting (their documented
plan modes bar the agent from changing any code and limit it to inspecting, searching and answering).
So Cascade gets the same wall, generic: **arg-scoped tool grants** (`tools/toolGrants.ts`). An agent's
`tools:` entry may now carry a scoped specifier — `Write(PLAN.md)`, `Bash(git:*)` — reusing the
existing permission-rule grammar (`permissions/rules.ts`: glob for file tools, segment-split for Bash).
A tool granted only with patterns is *wrapped*: input that doesn't match returns a teaching denial with
no execution. The planner's grant is `Write(PLAN.md)` — writing `src/App.tsx` is now physically
impossible, not merely discouraged.

- **Generic, not a planner hack** (no-overfitting rule): any agent can be scoped — a read-only
  reviewer, a `Bash(git:*)` helper, a docs-only writer. Enforcement lives with the capability (a
  wrapped tool), so it holds regardless of what the model is told, and works identically at the
  session level (plan stage) and the Subagent level (both allowlist sites call `scopeToolsByGrants`).
- The persona shrank accordingly: it no longer scolds ("you write EXACTLY ONE file"); it explains the
  wall ("your Write is scoped to PLAN.md; put implementation detail in the plan") — role guidance, with
  the hard limit enforced elsewhere.
- Deferred (v1 scope): scoped grants only guard `call()`, so a scoped tool that is
  `requiresUserInteraction` (AskUserQuestion/ExitPlanMode) would bypass the check — none exist today.

## Rung 5 — pinned context: the plan the builder can't ignore (added 2026-07-09, measured)

planner-4 proved the wall (planner writes only PLAN.md) and produced the best build yet — but forensics
found the next gap: **the builder read PLAN.md 0 times.** Its plan-shaped architecture was *convergent*
(planner and builder both apply the architecture skill to the same request), not *consumptive*. On a
one-shot build that's harmless; for the ITERATE case it is fatal — the plan exists precisely to survive
compaction and anchor round N+5 after the model's working memory is gone. A plan sitting on disk that
nobody reads is write-only.

Same lesson, final form: "read PLAN.md first" is a prompt, and prompts don't reliably drive this model
(and even an obeyed Read is ephemeral — compaction drops the result, and no later round re-reads). So
the plan becomes **ambient context**: `SessionOptions.contextFiles` pins files into the system prompt,
re-read FRESH each turn (exactly like memory), placed right after the behavioural rules that say to
follow them. Always present, always current (a later planner update propagates), never compacted, never
dependent on a Read. The builder pins `PLAN.md`.

- **Generic, not a plan hack:** core doesn't know PLAN.md means anything — any frontend can pin a
  README/CONVENTIONS file; the instruction to FOLLOW a pinned file lives in the frontend's
  BUILDER_BEHAVIOR. Mirrors how a project instruction file is always-in-context in mature coding agents.
- **Runner keep-awake** (`scripts/eval/keepAwake.mts`): the iterate proof needs a ~90-min run, past this
  box's 60-min sleep. A PowerShell child holds SetThreadExecutionState for the run's duration; killing it
  releases. This unblocks the measurement that rung 5 exists to satisfy.

## Verification

Unit: def loader (frontmatter, shadowing, `proactive`); named spawn through the real loop (child system
prompt = def body, tool allowlist enforced, skills preloaded); unknown-name error. Rung 2: nudge fires
once on write-without-PLAN.md with a proactive planner; suppressed by PLAN.md existing / planner already
spawned / passive planner (no `proactive: true`) / no planner def / depth > 0 (planNudge.test.ts).
Rung 3: trigger conditions (fresh + unplanned + proactive; user shadowing without the field silences),
the planner session's tool allowlist + persona + PLAN.md on disk, manager wiring, and the WS pipe
(planner events precede builder's, ONE turnDone) — planStage.test.ts + wsServer.test.ts. Rung 4:
scopeToolsByGrants — drops ungranted tools, passes bare grants through, wraps scoped tools (matching
path/command runs the real tool; a mismatch returns a teaching denial with zero execution), OR-s
multiple patterns, bare-beats-scoped, Bash segment-awareness (toolGrants.test.ts, 10 cases). Rung 5:
pinned files inject fresh each turn, re-read on change, missing/empty skipped, inert without the option,
multiple files each headed, placed after the rules (pinnedContext.test.ts, 7 cases). Bench: the builder
bench replicates the stage 1:1 (separate `<scenario>-planner.jsonl` trace); success = PLAN.md exists (and
is the ONLY planner write — denials on any `src/` write) before the first builder write, the plan is
pinned in the builder's system prompt, and (iterate) later rounds stay consistent with it across
compaction.
