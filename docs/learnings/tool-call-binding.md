# Learning: how the LLM's output becomes a tool's typed `input`

Two conversions, with the Zod `inputSchema` at both ends.

## Outbound — teach the model the shape
`toolSchemas()` runs `z.toJSONSchema(tool.inputSchema)` → sent in the request as
`tools:[{type:'function', function:{name, description, parameters}}]`. The model receives a JSON Schema
(properties + required) and, being trained on function-calling, emits JSON matching it.

## Inbound — model string → typed input
1. Model emits the call as a JSON **string**, streamed in fragments:
   `delta.tool_calls[i].function.arguments = '{"pat' … 'tern":"x"}'`.
2. Provider (`openaiCompat.stream`) **accumulates by index** then `JSON.parse`s **once**:
   `cur.args += tc.function.arguments` → `JSON.parse(cur.args)` → a JS object (`unknown`) →
   `yield { type:'tool_use', id, name, input }`.
3. Loop collects the `tool_use`; `executeTool` (`runTool.ts`) **validates with the same schema**:
   `tool.inputSchema.safeParse(input)` → on success `parsed.data` is fully typed → `tool.call(parsed.data, ctx)`.
   On failure → error result → model self-corrects.

## One line
```
Zod inputSchema ─z.toJSONSchema→ advertised to model
model JSON string ─accumulate→ JSON.parse → unknown ─safeParse→ typed input → tool.call(input, ctx)
```

## Why this matters
The Zod schema is the single source of truth: it **describes** args to the model (outbound) and
**enforces** them on the way back (inbound), so the advertised and validated shapes can't drift. The
model never calls our function directly — it produces a JSON string; the provider parses it and the
pipeline validates before `call()` ever runs.

## Prior art
The common pattern is the same: tool schemas converted Zod → JSON Schema for the API; streamed
argument-JSON deltas accumulated per block, then parsed once; the execution step `safeParse`s before
`tool.call()`.
