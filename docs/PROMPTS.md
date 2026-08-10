# PROMPTS.md — how prompt text is written, placed, and rated

Born from the 2026-08-11 prompt audit (wire dumps of Cascade vs a current production agent). The measured
failure was not bad sentences — it was **accretion**: rules appended wherever the cursor was, growing a
prompt with two identities, four voices, undeclared precedence, and rules duplicated across layers. On a
32K local window every duplicated rule is paid for in tokens AND in drift risk. This file is the lint
that keeps it from happening again. The shape itself is pinned by tests
(`projectManager.test.ts` "shape contract"; `projectContext.test.ts` "CLEAN of ancestor files").

## The spine

A prompt is a spine of headed sections, each answering exactly ONE question, in this order:

1. **Identity** — who the agent is, once. A session may refine it (the builder block) but must say so
   and declare precedence ("where they conflict, this section wins").
2. **Harness mechanics** — how output, compaction, reminders work. Not behavior — physics.
3. **Behavior** — doing tasks, tool routing, tone. The system prompt ROUTES ("plan with TodoWrite");
   the tool description SPECIFIES (the in_progress/completed discipline).
4. **Pinned context** — plan, tree, skills catalog, agents. Data, not instructions.

## The lint — every new bullet must pass all five

1. **Name its section.** If no existing section's question covers it, that's a design smell — argue for
   a new section, don't append to the nearest list.
2. **Name its measured failure.** A rule without a trace behind it is speculation; cite the run in a
   code comment next to the rule (the existing style: `// Measured (gpt-oss:20b, 2026-07-24): …`).
3. **One home.** Grep for the rule's key phrase before writing it. If a tool description already says
   it, the system prompt may only point. (The measured cases: TodoWrite's discipline stated twice,
   Bash's routing list stated twice, every skill name listed twice.)
4. **Carry its why.** "Do X because Y" generalizes; bare "do X" gets pattern-matched — weak models
   especially obey the shape of a rule, not its intent.
5. **Earn its emphasis.** NEVER/CAPS is a budget (the builder block's whole allowance is ~4). If the
   bullet needs shouting to work, the rule is probably in the wrong place or missing its why.

## Precedence, stated once

Order on the wire: core prompt → user memory (CASCADE.md tiers) → session role block → pinned context.
The role block declares that it wins over the generic core. Memory's "OVERRIDES defaults" header is
correct ONLY because the loader guarantees memory is user-authored: Cascade reads **CASCADE.md only,
at the project root only** — never other agents' instruction files (AGENTS.md etc.), never ancestor
directories (the measured poisoning: eval workdirs inside this repo inherited this repo's own
dev-agent instructions file, 6.5k chars of contradiction on every call).

## Rating cadence

Re-audit against a fresh WIRE DUMP (never the source, never memory of the source) once per release:
pull `model_request.system` from a real trace, diff its section map against this file's spine, and
count duplicates and shouts. The audit that started this file lives in the prompt-audit artifact
(2026-08-11); its yardstick — "every rule lives in the one section whose question it answers, and
appears exactly once" — is the pass/fail line.
