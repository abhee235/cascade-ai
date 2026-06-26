// llm/contextWindows.ts — best-effort model → context-window map (ADR-012). Used to size compaction when the
// user hasn't set cascade.contextWindow. Hosted models have known windows; local (Ollama) is a GUESS — its
// usable window is actually `num_ctx` (often 4k) regardless of the model's trained max, so for local models
// prefer the cascade.contextWindow override. Auto-detect via /api/show is deferred.

const WINDOWS: [RegExp, number][] = [
  [/gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|o4/i, 128_000],
  [/gpt-4/i, 8_192],
  [/gpt-3\.5/i, 16_385],
  [/claude/i, 200_000],
  [/qwen ?2\.5|qwen ?3|qwen2|qwen36/i, 32_768],
  [/llama ?3|llama3/i, 8_192],
  [/mistral|mixtral/i, 32_768],
  [/gemma ?2|gemma/i, 8_192],
  [/deepseek/i, 32_768],
  [/phi ?3|phi3/i, 4_096],
]

/** A known window for the model, or undefined (caller falls back to a configured value or a safe default). */
export function contextWindowForModel(model: string): number | undefined {
  for (const [re, win] of WINDOWS) if (re.test(model)) return win
  return undefined
}
