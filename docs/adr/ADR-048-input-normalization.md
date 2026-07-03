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
  demands); JSON-repair for the native-channel `{}` fallback in openaiCompat (different entry point of the
  same class); multi-key fuzzy matching (Levenshtein) — deliberately NOT done, aliases are auditable.

[inputNormalizer.ts]: ../../packages/core/src/tools/inputNormalizer.ts
[EVAL-BASELINE.md]: ../EVAL-BASELINE.md
