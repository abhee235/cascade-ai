# ADR-036 — Tool hooks: user-owned guards around tool execution (CORE-PARITY A5, hooks half)

> **Status:** accepted; implementing (v1 = PreToolUse + PostToolUse). The reserved-number ADR from
> CORE-PARITY A5. The rules half of A5 (input-aware permission patterns like `Bash(npm test:*)`) stays
> ADR-035, separate.

## Context

Every guard Cascade ships today is **harness-internal**: the permission gate (ADR-009), path confinement
(ADR-033), the verify gate (ADR-049), the delegation nudge (ADR-050). Users cannot add their own. But the
strongest safety property a harness can offer is exactly the one prompts cannot: **a deterministic rule the
model can't talk its way past** — "never touch `.env`", "no `rm -rf`", "lint every edit and make the model
fix what it broke". For a weak-model-first harness this matters MORE than for a frontier-model one: the weaker the
model, the less its compliance with prompt-stated rules can be trusted, so the floor must be structural.

**Prior art (the established hook protocol of terminal coding agents, studied for this ADR):**
- Events: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`/`SubagentStop`,
  `SessionStart/End`, `PreCompact`, `Notification`, …
- Config in settings: per-event list of `{ matcher, hooks: [{ type:'command', command, timeout? }] }`;
  matcher = `*`/empty (all) | exact/pipe-separated names | regex.
- Wire protocol: hook receives **JSON on stdin** (`hook_event_name`, `tool_name`, `tool_input`, …);
  decides via **exit code** — 0 = ok, **2 = block, stderr fed back to the MODEL** ("treat feedback from
  hooks as coming from the user"), other = non-critical (user-visible only) — or via **JSON stdout**
  (`hookSpecificOutput.permissionDecision: allow|deny|ask` + reason; hooks.ts:552, 2647).
- Placement: PreToolUse runs after mode/rule checks, **before** the user prompt — it can pre-empt the
  prompt in both directions. Hooks per event run in parallel; deny wins. Timeout default 10 min.

## Decision (v1)

A small hook engine in core + wiring at the scheduler gate. **Default-off by absence**: no
`.cascade/hooks.json` in the project ⇒ zero code path (the same discipline as every guard we ship).

1. **Config** — `.cascade/hooks.json` in the project root (the TodoStore precedent: core reads
   `cwd/.cascade/*` directly), in the common shape for least surprise:
   ```json
   { "PreToolUse":  [ { "matcher": "Write|Edit", "hooks": [ { "command": "node guards/no-env.mjs" } ] } ],
     "PostToolUse": [ { "matcher": "Edit",       "hooks": [ { "command": "node guards/lint.mjs", "timeout": 30 } ] } ] }
   ```
   Matcher semantics: `*`/empty → all; `[A-Za-z0-9_|]+` → exact/pipe list; else regex.
2. **Engine** ([hooks/hookRunner.ts], pure-ish + spawn): stdin JSON
   `{ hook_event_name, tool_name, tool_input, tool_response?, cwd, session_id }`; per-event hooks run in
   parallel; **30 s default timeout** (not the common 10 min — a hung guard must not hang the agent); decisions:
   - exit **2** → `deny`, stderr = the reason **the model sees**;
   - stdout JSON `permissionDecision: allow|deny|ask` (+ reason) → that decision;
   - exit 0 (no JSON) → no opinion; other exits / bad JSON / timeout → logged, no opinion (a broken guard
     must not brick the agent — fail-open for errors, fail-closed only on explicit block).
   - Aggregation: any `deny` wins → else any `ask` → else any `allow` → else no opinion.
3. **PreToolUse wiring** (scheduler, alongside `checkPermission` — the established placement): hook `deny` → the
   denied-result path with the hook's reason (model self-corrects); `allow` → skip the user prompt;
   `ask` → force the prompt; no opinion → normal ADR-009 flow. Traced as
   `{ t:'hook', event, tool, decision, ms }`.
4. **PostToolUse wiring** (scheduler, after results settle): exit-2 stderr is **appended to the
   tool_result content** — the feedback channel that lets a lint hook make the model fix its own edit.
5. **Host execution, by design**: hooks are the USER'S guards, not the model's tools — they run on the
   host regardless of the Bash sandbox, and are never advertised to the model.
6. **Untrusted-cwd opt-out** (`SessionOptions.loadProjectHooks: false`): host execution cuts both ways —
   in the web builder, the project dir is MODEL-WRITABLE and the session runs in bypass mode, so a
   model-written `.cascade/hooks.json` would execute arbitrary host commands at the next `open()` (a
   sandbox escape). The server therefore disables project-hook loading for builder sessions
   (`projectManager.ts`); the extension keeps the default (a workspace the user opened is user-trusted,
   the usual trust model for local agents).

**Deferred (v2+):** the other events (`Stop`, `UserPromptSubmit`, `SessionStart`, `PreCompact` — natural
extensions of the same engine); `updatedInput` rewriting; global (`~/.cascade`) config; ADR-035
input-aware rules.

## Consequences

- Users get deterministic guardrails with the established, documented hook protocol (transferable skills),
  and Cascade's detect→remind idiom (034/049/050) gains its user-extensible counterpart.
- Zero impact when unconfigured — asserted by the Tier-1 gate run (no hooks.json in eval fixtures).
- Verification: unit tests spawn REAL guard scripts (deny-by-exit-2 with reason-to-model, allow/ask JSON,
  PostToolUse feedback append, timeout kill, malformed-JSON tolerance, matcher table, no-config zero-path);
  Tier-1 no-regression gate before push.

[hooks/hookRunner.ts]: ../../packages/core/src/hooks/hookRunner.ts
