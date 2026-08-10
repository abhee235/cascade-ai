// hfDefaults.ts — the model AUTHOR's own defaults, fetched from the Hugging Face repo on add.
//
// The insight this encodes: the "best settings" people go searching the internet for are usually sitting
// IN THE REPO. Every HF model ships `config.json` (max_position_embeddings — the native context length)
// and most ship `generation_config.json` — the author's recommended sampling. Qwen3's, for instance,
// carries the exact temperature/top_p/top_k its model card tells you to use. Typing a model id and then
// hand-copying numbers from that same repo's README into sliders is busywork with a typo rate.
//
// Fetched ONCE, when the model is added, and persisted through the ordinary params path — so it lands in
// the database like anything else and never surprises the user by changing later. Fields the user already
// set are NEVER overwritten: the fetch fills blanks, it does not have opinions.

export interface HfDefaults {
	contextWindow?: number
	temperature?: number
	topP?: number
	topK?: number
	repeatPenalty?: number
	presencePenalty?: number
}

/** Only ids that are actually HF repo paths (`org/name`). Plain Ollama tags ("qwen36-agentic") and hosted
 *  ids without a slash are skipped outright; Ollama's `hf.co/org/name[:tag]` form is normalized to the
 *  repo path so GGUF pulls resolve too. */
export function hfRepoOf(modelId: string): string | undefined {
	const id = modelId.replace(/^hf\.co\//, '').replace(/:[^/]+$/, '') // strip Ollama's prefix and :quant tag
	return /^[\w.-]+\/[\w.-]+$/.test(id) ? id : undefined
}

const cache = new Map<string, HfDefaults | undefined>()

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
		if (!res.ok) return undefined // private repo, no such file — all fine, we just learn nothing
		return (await res.json()) as Record<string, unknown>
	} catch {
		return undefined
	}
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Fetch the repo's declared defaults. Undefined when the id is not HF-shaped or nothing useful was found.
 * Never throws; cached per id (repo files do not change under a running server in any way we should chase).
 */
export async function fetchHfDefaults(modelId: string): Promise<HfDefaults | undefined> {
	const repo = hfRepoOf(modelId)
	if (!repo) return undefined
	if (cache.has(modelId)) return cache.get(modelId)

	const base = `https://huggingface.co/${repo}/resolve/main`
	const [config, gen] = await Promise.all([fetchJson(`${base}/config.json`), fetchJson(`${base}/generation_config.json`)])

	// Multimodal architectures (Qwen3.5's Qwen3_5ForConditionalGeneration, and the *ForConditionalGeneration
	// family generally) nest the text model's config under `text_config` — the top level carries only the
	// vision/audio glue. Measured (Qwen/Qwen3.5-9B): max_position_embeddings=262144 lives ONLY there, so the
	// top-level-only read auto-filled nothing for the entire family.
	const textConfig = (config?.text_config ?? {}) as Record<string, unknown>
	const out: HfDefaults = {
		// The NATIVE trained length. A serving stack may allocate less (--max-model-len) — the live probe
		// wins for that — but as the default and the slider ceiling, this is the honest number.
		contextWindow: num(config?.max_position_embeddings) ?? num(textConfig.max_position_embeddings),
		temperature: num(gen?.temperature),
		topP: num(gen?.top_p),
		topK: num(gen?.top_k),
		repeatPenalty: num(gen?.repetition_penalty),
		// Qwen3.5 ships presence_penalty 1.5 as its author default — its own anti-loop insurance; carry it.
		presencePenalty: num(gen?.presence_penalty),
	}
	const any = Object.values(out).some((v) => v !== undefined)
	const result = any ? out : undefined
	cache.set(modelId, result)
	return result
}
