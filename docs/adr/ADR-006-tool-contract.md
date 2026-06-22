# ADR-006 — Tool contract: name + description + Zod inputSchema + call()

**Status:** Accepted (Phase 4)

## Context
The model needs to know what tools exist and how to call them; the runtime needs to validate the
model's JSON args and execute. One small interface should serve both.

## Decision
`tools/Tool.ts` defines `Tool<I>`:
- `name`, `description` — sent to the model (it decides when/how to call).
- `inputSchema: ZodType<I>` — **both** validates the model's args (`safeParse`) **and** is converted to
  JSON Schema (`z.toJSONSchema`) advertised to the model. One source of truth for the shape.
- `activitySummary(input)` — present-tense line for the UI card ("Reading package.json").
- `call(input, ctx): Promise<ToolResult>` — does the work; returns `{ content, isError? }`.

`tools/toolRegistry.ts` holds the list + `findTool(name)` + `toolSchemas()` (the provider-neutral
schemas). `tools/runTool.ts` `executeTool()` runs the pipeline: lookup → `safeParse` → `call` → wrap as
a `tool_result` block. **Errors are returned as results (`isError:true`), never thrown** — so the model
sees the failure and can self-correct (formalized in Phase 5).

`ToolContext` carries `{ cwd, abortSignal }` for now (grows with permissions/concurrency later).

## Consequences
- Adding a tool = one file + a registry entry; the loop and provider are untouched.
- Zod gives runtime validation for free and keeps the advertised schema in sync with the parser.
- The contract stays headless (no `vscode`/DOM) — tools run in any frontend.

## Prior art
Mature agents' tool interfaces are much larger (`isReadOnly`, `isConcurrencySafe`, `checkPermissions`,
result-to-block mapping, rendering, …). Cascade starts with the essential core and adds those fields in
their phases (flags P6, permissions P7). Zod→JSON Schema conversion is the common way to advertise them.
