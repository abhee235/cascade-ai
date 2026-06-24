# Learning: tool error handling has two layers

## Q: Why does Grep/Read catch errors but Glob doesn't — is that intentional?
Yes. There are **two layers**, and a tool only adds the second when it helps.

**Layer 1 — generic safety net (free for every tool).** `executeTool` wraps `tool.call()` in try/catch
([runTool.ts](../../packages/core/src/tools/runTool.ts)): anything thrown becomes a `tool_result` with
`isError: true`. So even Glob is fully covered — if `fast-glob` threw, the model would see the error and
self-correct.

**Layer 2 — tool-specific, expected errors (opt-in).** A tool adds its OWN catch only when there's a
*specific, predictable* failure where a tailored message helps the model fix it:
- `Grep`: `new RegExp(bad)` throws → "Invalid regex: …" tells it exactly what to fix.
- `Read`: ENOENT → "Error reading <path>: …" tells it the file is missing.

**Why Glob has none:** `fast-glob` rarely throws — a weird pattern just returns **zero matches**, which
isn't an error (Glob returns `"No files matched."` as a normal result). No common expected-failure worth
a custom message; the rare fs error is caught by Layer 1. A redundant try/catch would be noise.

## Rule of thumb
Add tool-specific error handling ONLY when you can give the model a clearer, more actionable message than
a raw exception. Otherwise rely on the pipeline's generic catch. Either way, errors are **returned, never
thrown** — that's what makes the agent self-correcting (ADR-007).

## Prior art
The common split is the same: tools provide input validation / specific checks where useful; the
execution layer is the generic catch-all that turns failures into `is_error` tool_result messages.
