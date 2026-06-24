# Learning: why a tool is an object, not a bare function

## Q: `GrepTool` doesn't look like a normal function — where's the input argument?
`GrepTool` is an **object** that implements the `Tool` interface, not a function. The function is one of
its fields: **`call`**. The input argument lives there: `async call(input, ctx)` — `input` is the model's
arguments (typed by `z.infer<typeof inputSchema>`), `ctx` is the `ToolContext` (`{ cwd, abortSignal }`).

`async call(input, ctx) { … }` is ES6 **method shorthand**, identical to:
```ts
{ call: async (input, ctx) => { … } }   // the fn() => {} form
```

## Why an object?
A bare function carries only behavior. A tool needs behavior **plus metadata** bundled together:
- `name` + `description` + `inputSchema` → so the model knows when/how to call it,
- `inputSchema` → so the runtime validates AND advertises the same schema,
- `activitySummary` → UI label,
- `call` → the work.

Bundling them in one object that satisfies `Tool<I>` keeps each tool **self-contained and
introspectable**: the registry is a `Tool[]`, the loop does `findTool(name)` then `tool.call(input, ctx)`.
A bare function would force name/description/schema to live separately and drift. This is the standard
"config object / plugin" pattern (like a React component def, an ESLint rule, an Express handler bundle).

## Type line decoded
```ts
export const GrepTool: Tool<z.infer<typeof inputSchema>> = { … }
```
- `const GrepTool` — a value (the object).
- `: Tool<…>` — its type; the `Tool` interface requires name/description/inputSchema/activitySummary/call.
- `z.infer<typeof inputSchema>` — the static TS type derived from the Zod schema, so `input` inside
  `call` is fully typed.

## Prior art
The common pattern: a `Tool` interface; every tool is an object with `name`, `description`,
`inputSchema`, `call()`, and, in mature agents, many more fields. Cascade's is the minimal version.
