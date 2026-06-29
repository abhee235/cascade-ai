# ADR-032 — Read-before-Edit freshness + Read windowing (CORE-PARITY A4 / C1 / C2)

## Context

The `Edit` tool replaces an exact `old_string` the model proposes **from memory**. Our previous `Edit`
([Edit.ts]) only re-read the file at edit time and checked that `old_string` was unique. That catches
"string not found" but not the real, *silent* failure mode of every coding agent: the model edits against a
**stale view** of the file —

1. it never actually `Read` the file (it guessed `old_string` from conventions);
2. the user, a **linter/formatter**, or an earlier tool changed the file *after* the model read it;
3. it read the file many turns ago and the surrounding code has shifted.

The established fix is a **read-state cache** keyed by path: every `Read` records what the model saw + the
file's mtime; `Edit`/`Write` refuse unless the file was read and hasn't gone stale. The usual shape: a
`FileState` type in an LRU; the read records `{content, timestamp: mtimeMs, offset, limit}`; the edit guard
asks for a read first when there is no read timestamp or only a partial view, and reports the file as
modified since read when `mtime > timestamp` **with a content-equality fallback**; and CRLF is normalized
to `\n` before matching.

## Decision

A **session-scoped `FileStateCache`** ([tools/fileState.ts]) records read state; `Read` writes it, `Edit`
enforces it.

- **`FileState = { content, timestamp, partial? }`** — the CRLF-normalized content the model saw, the file's
  mtime (ms) at read, and `partial` when we truncated a huge read. Keys are `resolve()`-normalized so a
  relative `Read` and an absolute `Edit` hit the same entry (the standard normalization for `/`-vs-`\`).
  A plain `Map` with a soft 200-entry cap (a 25 MB LRU is the heavier alternative — overkill for now).
- **Lives on the session** ([session.ts]), threaded `LoopDeps → ToolContext.readFileState → tools`, and
  **shared with subagents** — so a file read in one turn is editable in a later one (session-level, not
  per-turn). Absent ⇒ no enforcement (headless smoke tests stay simple).
- **`Read` records** `{content, mtime}` after a successful read and returns CRLF-normalized text so the
  model's view matches what `Edit` matches against.
- **`Edit` guard** (skipped when no cache is wired): no entry → *"…has not been read yet. Read it first."*;
  `currentMtime > storedMtime` **and** content actually differs → *"…modified since you read it… Read it
  again."* (the content fallback avoids Windows mtime false-positives from cloud-sync/antivirus). It matches
  on CRLF-normalized content, and **refreshes the cache to the just-written state** so a second edit in the
  same turn isn't wrongly rejected (we are the modifier).
- The errors are **structured messages the model reads and self-corrects from** — the guard turns a stale
  edit into a Read-then-retry, i.e. a self-healing loop rather than a silent corruption.
- **Read windowing (C1).** `Read` gains `offset` (1-based start line) + `limit` (line count), emits content
  with **line numbers** (`␣␣␣␣␣1→…`, the usual line-number gutter; display-only — Edit matches the raw file), and a
  whole-file read over the size cap **errors** ("read it in parts with offset/limit") instead of silently
  truncating. A windowed read is recorded `partial: true`; Edit then re-requires a Read on **any** later mtime
  change (no content fallback — only a slice was seen), i.e. a full-read gate.

## Consequences

- **Correctness.** The classic stale-edit bug is closed. Verified headless against the real tool code (the
  exact path the agent hits): edit-before-read → blocked; read→edit → ok; second consecutive edit → ok;
  external-change-after-read → blocked; re-read→edit → ok; a `\r\n` file edited with a `\n` `old_string` →
  matches (normalization).
- **Deferred (CORE-PARITY follow-ups):** `Write` overwrite-freshness; encoding detection (UTF-16 BOM); images
  / PDFs / notebooks in `Read` (rest of C1). `Edit` line endings are normalized to `\n` on write (acceptable,
  and the common behaviour).
- **Seams unchanged.** Core stays headless; the cache is an optional context field, like `sandbox`/`archival`.

[Edit.ts]: ../../packages/core/src/tools/builtins/Edit.ts
[tools/fileState.ts]: ../../packages/core/src/tools/fileState.ts
[session.ts]: ../../packages/core/src/session.ts
