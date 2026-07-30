// modelSpecs.ts — per-model LIMITS + capabilities for the config UI (ADR-067). The sliders in the model
// manager must range over what a model ACTUALLY supports, not a global guess: a model's official max context
// window / max output tokens / temperature ceiling, and whether it exposes top_k at all. For HOSTED models
// (no live /api/show probe) this table is also the source of the tools/vision capability badges.
//
// Values are the vendors' OFFICIAL published maxima — compiled from vendor model cards / docs (research task,
// 2026-07; `source` per row). Match is by lowercased substring of the model id, MOST-SPECIFIC FIRST (first hit
// wins) so "gpt-4.1-mini" resolves before "gpt-4.1" and "llama3.2-vision" before "llama3.2".
//
// Caveats baked into the numbers:
//  • Reasoning models (o1/o3/o4-mini, gpt-5 family) DON'T accept a tunable temperature — the API fixes it at
//    the default. We encode tempMax:1 for them (the value the API allows); the OpenAI Responses provider never
//    sends temperature to these anyway.
//  • Open-weight outputMax is rarely a hard vendor cap (generation is bounded by remaining context) — the
//    figures are documented/typical defaults, used as sensible slider ceilings.
//  • topK is true only for open-weight families (they run through Ollama/llama.cpp, which exposes top_k);
//    hosted chat APIs (OpenAI/Groq/NIM-OpenAI-compat) expose only temperature/top_p.
//
// Unknown model ⇒ DEFAULT_LIMITS (256K context ceiling), but a live-detected window (Ollama num_ctx) always
// wins so the slider reflects the real Modelfile allocation.

export interface ModelLimits {
	/** Max context window (tokens) — the slider's upper bound. */
	contextMax: number
	/** Max output/completion tokens per request — the output slider's upper bound. */
	outputMax: number
	/** Highest temperature the API accepts (chat: 2; reasoning models: fixed 1). */
	tempMax: number
	/** Whether the inference API exposes top_k (open-weight/Ollama: yes; hosted chat: no). */
	topK: boolean
}

interface SpecRow extends ModelLimits {
	/** Lowercased substring that identifies the family in a model id. */
	match: string
	/** Function/tool calling support (for the capability badge on hosted models). */
	tools: boolean
	/** Image input support (badge on hosted models; Ollama models are probed live instead). */
	vision: boolean
	source: string
}

// Ordered most-specific → least-specific. Both hyphen (vendor) and no-hyphen (Ollama) id styles are covered,
// with generic family fallbacks last so novel tags (e.g. "qwen36-agentic", "gemma4") still resolve sensibly.
export const MODEL_SPECS: SpecRow[] = [
	// ── OpenAI hosted (no top_k) ──
	{ match: 'gpt-4.1-nano', contextMax: 1_047_576, outputMax: 32_768, tempMax: 2, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-4.1-nano' },
	{ match: 'gpt-4.1-mini', contextMax: 1_047_576, outputMax: 32_768, tempMax: 2, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-4.1-mini' },
	{ match: 'gpt-4.1', contextMax: 1_047_576, outputMax: 32_768, tempMax: 2, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-4.1' },
	{ match: 'gpt-4o-mini', contextMax: 128_000, outputMax: 16_384, tempMax: 2, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-4o-mini' },
	{ match: 'gpt-4o', contextMax: 128_000, outputMax: 16_384, tempMax: 2, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-4o' },
	{ match: 'o4-mini', contextMax: 200_000, outputMax: 100_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/o4-mini' },
	{ match: 'o3', contextMax: 200_000, outputMax: 100_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/o3' },
	{ match: 'o1', contextMax: 200_000, outputMax: 100_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/o1' },
	// gpt-5.6-luna — the flagship: 1M context window. Matched before the generic gpt-5 row.
	{ match: 'gpt-5.6-luna', contextMax: 1_048_576, outputMax: 128_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-5.6-luna' },
	{ match: 'gpt-5.6', contextMax: 1_048_576, outputMax: 128_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models' },
	// Earlier gpt-5 family: 400K window (~272K in + 128K out), fixed temp.
	{ match: 'gpt-5', contextMax: 400_000, outputMax: 128_000, tempMax: 1, topK: false, tools: true, vision: true, source: 'platform.openai.com/docs/models/gpt-5' },
	// ── Open-weight local (Ollama / llama.cpp: top_k available; tools/vision probed live for these) ──
	{ match: 'qwen2.5-coder', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct' },
	{ match: 'qwen2.5-vl', contextMax: 32_768, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: true, source: 'huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct' },
	{ match: 'qwen2.5', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/Qwen/Qwen2.5-7B-Instruct' },
	{ match: 'qwen3', contextMax: 131_072, outputMax: 32_768, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/Qwen/Qwen3-8B' },
	{ match: 'qwen', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'qwenlm.github.io' },
	{ match: 'deepseek-r1', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/deepseek-ai/DeepSeek-R1' },
	{ match: 'deepseek-v3', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/deepseek-ai/DeepSeek-V3' },
	{ match: 'deepseek', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'api-docs.deepseek.com' },
	{ match: 'llama3.3', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.3-70B-Instruct' },
	{ match: 'llama-3.3', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.3-70B-Instruct' },
	{ match: 'llama3.2-vision', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: true, source: 'huggingface.co/meta-llama/Llama-3.2-11B-Vision-Instruct' },
	{ match: 'llama3.2', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.2-3B-Instruct' },
	{ match: 'llama-3.2', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.2-3B-Instruct' },
	{ match: 'llama3.1', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.1-8B-Instruct' },
	{ match: 'llama-3.1', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama/Llama-3.1-8B-Instruct' },
	{ match: 'llama', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/meta-llama' },
	{ match: 'gemma3', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: true, source: 'huggingface.co/google/gemma-3-4b-it' },
	{ match: 'gemma2', contextMax: 8_192, outputMax: 8_192, tempMax: 2, topK: true, tools: false, vision: false, source: 'huggingface.co/google/gemma-2-9b-it' },
	{ match: 'gemma', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: true, source: 'ai.google.dev/gemma' },
	{ match: 'mistral-nemo', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'ollama.com/library/mistral-nemo' },
	{ match: 'mixtral', contextMax: 65_536, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'ollama.com/library/mixtral' },
	{ match: 'mistral', contextMax: 32_768, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'ollama.com/library/mistral' },
	{ match: 'nemotron', contextMax: 131_072, outputMax: 16_384, tempMax: 1, topK: false, tools: true, vision: false, source: 'build.nvidia.com/nvidia/llama-3_3-nemotron-super-49b-v1' },
	{ match: 'phi4', contextMax: 16_384, outputMax: 16_384, tempMax: 2, topK: true, tools: false, vision: false, source: 'ollama.com/library/phi4' },
	{ match: 'phi-4', contextMax: 16_384, outputMax: 16_384, tempMax: 2, topK: true, tools: false, vision: false, source: 'ollama.com/library/phi4' },
	{ match: 'phi3', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: false, vision: false, source: 'huggingface.co/microsoft/Phi-3-mini-128k-instruct' },
	{ match: 'phi', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: false, vision: false, source: 'huggingface.co/microsoft' },
	{ match: 'hermes', contextMax: 131_072, outputMax: 8_192, tempMax: 2, topK: true, tools: true, vision: false, source: 'huggingface.co/NousResearch' },
	{ match: 'nomic-embed', contextMax: 8_192, outputMax: 512, tempMax: 1, topK: false, tools: false, vision: false, source: 'huggingface.co/nomic-ai/nomic-embed-text-v1.5' },
]

/** ADR-067 fallback: an unknown model. 256K context ceiling per spec; a live-detected window overrides it. */
export const DEFAULT_LIMITS: ModelLimits = { contextMax: 262_144, outputMax: 8_192, tempMax: 2, topK: true }

const specFor = (model: string): SpecRow | undefined => {
	const id = model.toLowerCase()
	return MODEL_SPECS.find((r) => id.includes(r.match))
}

/** The limits for a model. `provider` sets the top_k default when the model isn't in the table (hosted chat
 *  APIs have no top_k). `detected` is the live-probed context window (Ollama num_ctx) — it RAISES the context
 *  ceiling so the slider can reach the real Modelfile allocation even if it exceeds the table/default. */
export function limitsFor(provider: string, model: string, detected?: number): ModelLimits {
	const row = specFor(model)
	const base: ModelLimits = row
		? { contextMax: row.contextMax, outputMax: row.outputMax, tempMax: row.tempMax, topK: row.topK }
		: { ...DEFAULT_LIMITS, topK: provider === 'ollama' }
	// top_k is a property of the SERVING API, not the weights: only Ollama's native endpoint exposes it. A
	// llama/qwen model served by a hosted OpenAI-compat gateway (Groq/NIM/OpenRouter) has no top_k, even
	// though the open-weight family "supports" it — so the provider is the final authority.
	base.topK = provider === 'ollama' && base.topK
	if (detected && detected > base.contextMax) base.contextMax = detected
	return base
}

/** Spec-derived capabilities (tools/vision) for a model, used to badge HOSTED models that have no live probe.
 *  Returns undefined when the model isn't in the table (caller keeps its own detection). */
export function specCapabilities(model: string): string[] | undefined {
	const row = specFor(model)
	if (!row) return undefined
	return [...(row.tools ? ['tools'] : []), ...(row.vision ? ['vision'] : [])]
}
