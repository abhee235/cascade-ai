# ADR-059 — Post-edit diagnostics: push type errors after every mutating turn (+ sampling fix)

Status: accepted · 2026-07-19

## Context — recognition is the gap, again

The Lsp tool (CORE-PARITY, real TS LanguageService: diagnostics/definition/references/hover) has been
advertised in every builder session. Measured across the day's three Simmer submits (90+ turns): the
model called it **zero** times, while both of the session-killing bugs were plain type errors it would
have surfaced instantly (hand-typed `PhotoName` union drift; `favorite` missing on 5 seed recipes; a
duplicate-brace syntax corruption from a partial edit). Editor-integrated agents solve this by *pushing*
IDE diagnostics to the model after every edit — no recognition required. Same lesson as ADR-050:
weak models execute directives; they do not notice capabilities.

## Decision

`agent/postEditCheck.ts`, wired into the loop after each tool batch (detect→inject family):

- After a turn that successfully Write/Edit/MultiEdit-ed any `.ts/.tsx/.js/.jsx` file, the harness runs
  ONE type check for the batch (writes are serialized — end-of-turn state is what compiles).
- Routing mirrors the Lsp tool: sandbox present → `npx tsc --noEmit --pretty false` INSIDE it (it has
  the real node_modules, which live in a container volume); no sandbox → in-process LanguageService on
  just the edited files.
- Errors are injected as a `<system-reminder>`: edited-file errors first, capped at 5 with a remainder
  count, total project error count, "fix the FIRST error" directive, task re-anchor. A clean check, a
  missing tsc (deps not installed yet), or a 20s timeout injects **nothing** — the reminder only exists
  when there is something real to fix.
- Default ON when a sandbox exists (builder/eval); OFF on the bare host (extension chat — the IDE
  already shows diagnostics, and a monorepo-wide LanguageService build is costly). Opt in/out via
  `LoopDeps.postEditCheck`. Trace event: `post_edit_check`.
- Deliberately does NOT touch verify-gate state: the gate still owns "done means the DECLARED check ran"
  (vite build catches what tsc alone does not).

## Companion fix — sampling parameters were corrupting tool arguments

The 128k retest exposed token-level degradation past ~45k context: hallucinated path prefixes
(`/vspher/home/usersrc/…`, `/vsphericmsrc/…`), a todo-JSON fragment pasted into `file_path`, required
keys (`activeForm`) dropped from TodoWrite calls. Cause: the Modelfile pinned `presence_penalty 1.5`
(a Qwen chat-mode anti-repetition setting) — it penalizes every token already present in context, and
an agent's correct behavior *is* re-emitting identical paths/keys hundreds of times. At 50k tokens the
penalty made the exact strings unavailable and the model emitted mutations. Changed (Modelfile
recreated): `presence_penalty 1.5 → 0.5`, `temperature 1 → 0.6` (Qwen3 thinking-mode recommendation;
top_p 0.95 / top_k 20 already matched). Watch item: if token-repetition loops reappear at 0.5, handle
them in the harness (the stall watchdog + read-loop gate), not by re-poisoning exact-string recall.

## Amendment (run 4, 2026-07-20) — the check was live and still blind; three friction fixes

The first session with this rung active hit the 80-turn cap with `post_edit_check=0`. Forensics:

1. **The fake-tsc trap.** The check ran `npx tsc` in the sandbox; the project's deps were never installed,
   so npx fetched the impostor `tsc@2.0.4` package ("This is not the tsc command you are looking for") —
   zero parseable lines, silent no-op, all session, while three files sat with syntax errors. Fixed: the
   check (and checkProject.ts) run `node_modules/.bin/tsc`; a `not found` result now means "deps were
   never installed" and injects an `npm install` DIRECTIVE (once per submit) instead of staying silent —
   the missing toolchain was the run's root blocker (`npm run build` → `sh: tsc: not found`, twice).
2. **Bare-absolute path re-rooting** (projectPath B2). The model wrote `/src/components/HomeView.tsx`
   (dropped `/workspace`) — 21 calls denied in one run. A bare absolute whose first segment is a real
   top-level project entry now re-roots; true host paths and `..` escapes still reject.
3. **TodoWrite `activeForm` optional** (ADR-048 tolerant-args family), defaulting to `content` — 5 schema
   rejections in one run for a display-only field.

Together the three accounted for ~30 of the run's 80 turns. Tests: postEditCheck (fake-tsc command guard,
missing-deps directive + once-per-submit latch), projectPath.test.ts, todoDropGuard activeForm default.
Suite 391 green.

## Verification

`postEditCheck.test.ts` (6: file filtering, tsc parsing/ordering/cap, clean/unavailable/failure paths,
through-the-loop injection) + watchdog re-arm-on-failed-attempt test. Full suite 383 green. Product
proof pending: rerun Simmer — expect the existing data.ts syntax corruption to be reported on the first
touch of the file, and `post_edit_check` events in the trace replacing multi-turn error hunts.
