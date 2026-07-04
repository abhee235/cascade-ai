# ADR-048 — Tool-input normalization + directive validation errors (the `invalid_args` rung)

> **Status:** implemented. Second harness change driven end-to-end by the eval (after ADR-047): the
> baseline named the class, traces supplied the exact payloads, unit tests pin those payloads, the rerun
> measures the shift.

## Context

After ADR-047 (prose fallback), the weak-tier run (`prose-fallback-3b`) moved its failures to
**4× `invalid_args`** — and the traces show precisely what that means for a 3B:

- `Read {"path": "src/report.js"}` — right value, wrong key (`file_path`) — **15× in one task**
- `Read {"glob": "format.js"}`, `Edit {"content", "path"}`, `Write` missing `file_path` entirely
- and the model retried the **identical wrong call 4×**, because our error was a raw Zod JSON dump
  (`[{"expected":"string","code":"invalid_type","path":["file_path"]…]`) that a 3B cannot turn into
  an action.

Frontier-model harnesses never see this class (frontier models emit correct keys); a weak-model-first harness lives
in it. The knob named by the routing table: schema-level coercion + actionable errors.

## Decision

Two remedies at the **runTool seam** (one place, every builtin benefits; MCP tools unaffected — their
servers validate):

1. **`normalizeInput`** ([inputNormalizer.ts]): when validation fails, move known ALIAS keys onto the
   canonical schema key and re-validate once. Aliases observed/conventional: `path|filepath|filename|file|glob
   → file_path`, `cmd|script → command`, `old|find → old_string`, `text|body → content`, etc., plus
   case-variant folding (`File_Path → file_path`). **Conservative by construction:**
   - never overwrites a key the model actually sent;
   - never repurposes a key that is itself valid in the schema — `Glob {path}` (a legit optional dir)
     is NOT moved onto the missing `pattern` (pinned by test);
   - introspects Zod object shapes, reaching through `.refine()` wrappers; non-object schemas skip.
2. **`describeInvalidInput`**: replaces the Zod dump with a compact directive —
   `Invalid input for Read: file_path (expected string). Expected keys: file_path, offset, limit.
   You sent: path. Fix the argument names/types and call Read again.` — capped < 300 chars so a small
   model can act on the retry.

## Consequences (measured)

- **Unit:** 9 tests pinned to the exact 3B payloads, including the conservative rules and a real
  `executeTool` e2e (`Read {path}` now succeeds). Suite: 210 green.
- **Eval delta (`invalid-args-3b` vs `prose-fallback-3b`):** honest and instructive —
  - the mechanical fix works: the worst task's tool-error count went **15 → 0** (feature-stats-module now
    reads files freely); suite-wide invalid-arg retries collapsed (e.g. 14→7, 9→4 errors on grind tasks);
  - class distribution: `no_tool_use` 1→0, `invalid_args` 4→**3**, `false_done` 5→**7**; solves 0/10 → 0/10.
  - Interpretation: unblocking the arg errors reveals the 3B's true ceiling — it now performs its one or
    two rescued actions cleanly and then **stops without verifying** (`false_done`, now 7/10). The next
    rung is unambiguous, and it showed up at BOTH ends of the curve (both polyglot failures on the 35B were
    also `false_done`) → the highest-leverage next fix is a **verification gate**, not more parsing.
- Strong-tier Tier-1 gate: run alongside (normalization only activates on inputs that would have failed
  anyway, so it can only add successes); result recorded in [EVAL-BASELINE.md].
- **Deferred:** value coercion beyond keys (string→number etc. — Zod `coerce` per-schema when evidence
  demands); ~~JSON-repair for the native-channel `{}` fallback in openaiCompat~~ (**done — addendum below**);
  multi-key fuzzy matching (Levenshtein) — deliberately NOT done, aliases are auditable.

## Addendum (2026-07-04): item 4 — the other two entry points of the same class

**4a — JSON repair + honest sentinel ([jsonRepair.ts]).** The provider swallowed unparseable tool args
(`catch { input = {} }`), so the model was told "missing required file_path" — a lie about its own syntax
error. Now: a pure repair ladder (fence/prose unwrap → trailing commas → unquoted keys → single quotes →
truncation-close, cumulative, object-result-only) fixes what is mechanical; anything else flows through as
`{ __rawArgs }` and runTool answers with the DIRECTIVE truth: *"MALFORMED arguments — you sent: … — call
again with ONE valid JSON object using keys …"*. Both wire paths (`/v1` accumulated string, native
string-typed `arguments`) route through it. Truncation matters more post-ADR-038: `num_predict` on the wire
means max-token cuts mid-arguments are a real, recurring shape. 14 unit tests incl. a mocked-SSE wire test
and a repair-never-invents-content guard (a Bash command full of quotes/braces survives byte-for-byte).

**4b — whitespace-tolerant edit matching ([editCore.ts] `findEditTarget`, shared by Edit + MultiEdit).**
The `edit_mismatch` class: weak models reproduce the CODE of `old_string` but not its WHITESPACE (tabs
retyped as spaces, wrong depth), and the exact matcher's "not found" sends them into identical-retry
loops. The usual ladder stops at exact + curly-quote normalization — sufficient for frontier models, not for 3B
locals. Ours: exact first (contract unchanged, incl. ambiguity errors); on zero hits, a line-trimmed
sliding-window match that only counts when UNIQUE, replaces the FILE's own bytes (never the model's
whitespace), and remaps `new_string` indentation per-depth from the matched window's model↔file indent
pairs. `replace_all` stays exact-only (fuzzy replace-all is how a rename rewrites lines the model never
saw). Not-found errors now carry a near-miss hint ("line N matches one of its lines — re-Read"). 9 tests
incl. end-to-end through both tools on real files.

**Measured (json-repair-3b, same 10 tasks):** no class flip — 0/10 → 0/10, `invalid_args` 3→3 (the
survivors are wrong-KEY schema errors, this ADR's original class, not JSON syntax; repaired calls are
invisible by design). The 3B's dominant class remains **false_done (finishes without running tests)** even
with the ADR-049 verify nudge active — that is the next measured rung for the weak tier, not more parsing.
Combined item-4 no-regression gate on the strong tier: see [EVAL-BASELINE.md].

[inputNormalizer.ts]: ../../packages/core/src/tools/inputNormalizer.ts
[jsonRepair.ts]: ../../packages/core/src/llm/jsonRepair.ts
[editCore.ts]: ../../packages/core/src/tools/editCore.ts
[EVAL-BASELINE.md]: ../EVAL-BASELINE.md
