# ADR-041 — LSP tool: real semantic code intelligence (CORE-PARITY §B: LSPTool)

> **Status:** accepted; **implemented** for TypeScript/JavaScript (diagnostics · definition · references · hover).

## Context

Cascade's perception tools were **textual**: Grep finds "lines containing `foo`", Glob finds files by name. A
coding agent — especially a weak local model — needs **semantic** truth: the *actual* definition of a symbol,
*every* caller before a rename, and whether an edit **compiles**. `tool-faculties.md` names this the LSP gap:
*"the actual definition and everyone who calls it" vs "lines containing foo"*. Two concrete weak-model wins:

- **Verify-before-done** (ADR-037's behavioural rule) needs a real answer to "did my change type-check?" — Grep
  can't give it.
- **Safe refactors**: renaming a symbol requires *all* references; a text search silently misses aliased or
  shadowed uses and matches unrelated strings.

## Decision

An **`Lsp` tool** backed by the **in-process TypeScript `LanguageService`** (`lsp/tsService.ts`) — not a spawned
`typescript-language-server`. Rationale: `typescript` is already a core dep; in-process means no JSON-RPC server
lifecycle to manage; and the LanguageService is session-warm + incremental (cached per project root; file
versions are mtime-based, so edits by the `Edit` tool are picked up on the next call).

One tool, four ops: `diagnostics · definition · references · hover` (the last three take a 1-based
`line`+`column`). Output is `file:line:column` locations / `file:line:col: severity TSxxxx: message` — the same
shape as our other tools, so a weak model can feed a location straight back into `Read`/`Edit`.

**Two backends, chosen per-op** (the deployment split, same one ADR-033 reconciled):

- **Navigation** (definition/references/hover) → the LanguageService over project SOURCE, read host-side (the
  bind-mount). Project-symbol navigation works in **both** deployments.
- **Diagnostics** → the **sandbox `tsc`** (`ctx.sandbox.exec('npx tsc --noEmit --pretty false')`, reusing
  server/checkProject's parser) when a sandbox is present — because accurate diagnostics need the project's
  `node_modules`, which lives in a Docker volume (not the host bind-mount) for the web build. Host LanguageService
  is the fallback (extension / no sandbox). Results are filtered to the requested file.

File paths are **confined to the project** (`resolveInProject`, ADR-033). Windows: everything is normalised to
forward slashes — TS keys program files that way, and a back-slash query would silently match nothing.

## Consequences

- **Real semantic intelligence for TS/React** (Cascade's stack): the agent can verify compilation and navigate
  by meaning, not text — directly strengthening verify-before-done and safe refactors for a weak model.
- **Beyond Grep, not a replacement:** Grep/Glob stay for text/name search; the tool description steers the model
  to `Lsp` only when it needs semantic truth.
- **Scope: TS/JS only.** Fine — Cascade builds TS/React apps. Other languages would need their own backend
  (a real language-server client behind the same tool shape) — deferred until a non-TS template exists.

## Verification

- Headless (7/7): against a temp TS project with a deliberate `TS2322` + a cross-file symbol — diagnostics pins
  `2:7: error TS2322: … not assignable`; `definition` jumps to `util.ts:1`; `references` returns all 4 uses;
  `hover` gives `greet(name: string): string`; a nav op without line/column and a path outside the project both
  return self-correcting errors.
- (Follow-up) live: on `coding-qwen36`, edit a file to introduce a type error and confirm the model calls
  `Lsp diagnostics` to catch it before reporting done.

## Follow-ups

- `rename` (apply an edit across all references) — pairs with MultiEdit.
- Route diagnostics through the sandbox path in the web build end-to-end (unit-tested via the host fallback here).
- Non-TS languages behind the same tool shape when a template needs them.

[lsp/tsService.ts]: ../../packages/core/src/lsp/tsService.ts
