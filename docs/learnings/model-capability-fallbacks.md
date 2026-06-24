# Learning: what if the model doesn't support native tool calling?

Local models vary. There's a capability spectrum, and the fallback always lives in the **provider**,
never in the loop.

## Spectrum (best → weakest)
1. **Native tool calling** (Cascade today): model + provider speak OpenAI `tools` → `tool_calls`. Most
   reliable. Ollama supports it only for tool-capable model templates (qwen2.5-coder, qwen3, llama3.1…).
2. **Structured / JSON output only**: model can be forced to emit valid JSON (`response_format:
   json_schema`, or llama.cpp GBNF grammar) but not the `tool_calls` protocol. **Emulate**: prompt it to
   output `{"tool":"Grep","input":{…}}`, constrain decoding to the schema (guaranteed-valid JSON), parse
   it yourself. Almost as reliable as native.
3. **Plain-text deltas only** (base/small models): no tool_calls, no JSON mode. **Prompt-based ReAct** —
   describe tools in the system prompt, instruct a parseable marker (e.g. `<tool_call>{…}</tool_call>`),
   parse the text yourself, run, feed back, loop. Least reliable (mis-format/hallucinate) → needs
   forgiving parsing + retries + firm maxTurns. This predates native function calling (early LangChain).

## Why our architecture absorbs all three
The loop only consumes **`tool_use` StreamEvents** — it doesn't know if they came from native
`tool_calls`, parsed JSON, or scraped text. So a weaker model just needs a **different provider** (or a
mode in openaiCompat) that injects tool descriptions into the prompt, parses the text stream, and yields
the SAME `tool_use` events. The loop, tools, and UI are untouched. That's the payoff of ADR-020
(provider abstraction) + the StreamEvent boundary.

## Cascade's stance
Tier 1 only (native via Ollama `tools`) → requires a tool-capable model (default `qwen36-agentic`). Point
`cascade.model` at a non-tool model and Ollama ignores `tools`/errors → plain chat, no tool cards.
Tiers 2–3 would be a new provider variant, not a loop change. Optional extension, not core curriculum.

Reliability: native `tool_calls` > JSON-schema-constrained > prompt-based ReAct. Use the highest tier the
model supports.

## Prior art
An agent that targets a single hosted model family which always supports tool use needs no fallback. The
prompt-based technique is what the broader ecosystem (ReAct-style frameworks) uses for non-tool models.
