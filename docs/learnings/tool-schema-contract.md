# Learning: how Zod schemas reach Ollama as tools (the contract)

## Q: How does the Zod schema correctly match Ollama's tools in the request body? Is there a Zod↔Ollama contract, or does Ollama accept any format?
**No direct Zod↔Ollama contract.** Interop rides on **two stacked public standards**:
1. **JSON Schema** — what `z.toJSONSchema(inputSchema)` emits (`type`/`properties`/`required`/`$schema`…).
2. **OpenAI tool-calling envelope** — `{ type:"function", function:{ name, description, parameters } }`, where
   `parameters` *is a JSON Schema object*. Ollama's `/v1/chat/completions` is OpenAI-compatible, so it
   implements that shape.

Chain: **Zod → JSON Schema → OpenAI function envelope → Ollama**. Neither side knows about Zod; they meet
at two specs. Same reason the code drives OpenAI/Groq/OpenRouter unchanged (ADR-020).

Code hops: `tools/toolRegistry.ts toolSchemas()` (`z.toJSONSchema`) → `llm/providers/openaiCompat.ts
toOpenAITools()` (wrap as `{type:'function',function:{…}}`) → request body `tools[]`.

## Any format? No — but lenient.
The shape MUST be the OpenAI envelope. But Ollama does **not strictly validate** the JSON Schema — it
injects `tools` into the model's **chat template** (Jinja), which renders them into the prompt (usually as
JSON). Unknown keywords (`$schema`, `additionalProperties`) are typically passed through/ignored. How well
the model uses them depends on the model + template, not validation.

## The key insight: the schema is sent twice, for two jobs
- **Outbound** (`toJSONSchema` → prompt) = an **advisory hint**. The model can ignore it: missing/extra/wrong
  fields, even malformed JSON. NOT enforced.
- **Inbound** (`inputSchema.safeParse` in `tools/runTool.ts`, Phase 5) = the **authoritative contract**. The
  model's `tool_calls.arguments` (a JSON string) is accumulated + `JSON.parse`d, then `safeParse`d. Mismatch
  → error `tool_result` → model self-corrects.

**One Zod schema, two roles:** advertise (loosely, to guide) + enforce (strictly, on the way back). The
outbound contract is a suggestion; the inbound one is the law. That's why it's robust even though the model
never strictly honors the advertised schema. See [[tool-call-binding]].

## Gotcha
`z.toJSONSchema` emits `"$schema"` and `"additionalProperties": false`. Ollama tolerates both; coincidentally
that's also what OpenAI *strict* function-calling wants. A fussier provider might need `$schema` stripped —
not required for Ollama.

## Prior art
The common idea: Zod tool input schemas → JSON Schema advertised to the model, then the returned args
are validated before the tool runs. Advertise loosely, validate strictly.
