// launchCommand.ts — the EXACT command to start a local model server, built from the user's own config.
//
// Two moments need it. When a local backend (ollama / vllm) is not reachable, the Model Manager's catalog
// pane would otherwise show an empty list that reads as "no models exist" — the honest answer is "nothing
// is listening at the default origin, and this is the command that fixes it". And for a vLLM model, the
// serve command is CONFIGURATION: --max-model-len must match the context window set here, and the
// tool-parser flags are make-or-break — without --enable-auto-tool-choice the server emits no tool_calls
// and the agent chats about editing files instead of doing it, which looks exactly like a broken harness.
//
// The flags are derived, not memorized by the user: parser from the model family, reasoning parser for
// thinking families, context length from the model's configured window.

/** The tool-call parser vLLM needs for a model family. Wrong (or absent) parser = no tool_calls at all. */
function toolParserFor(model: string): string {
	const m = model.toLowerCase()
	if (m.includes('mistral')) return 'mistral'
	if (m.includes('llama-3') || m.includes('llama3')) return 'llama3_json'
	// hermes covers Qwen (2.5 and 3.x) and is the widest-supported default for open models.
	return 'hermes'
}

/** The reasoning parser for thinking families — routes <think> into reasoning_content, which the
 *  streamer understands. Omitted for non-thinking models. */
function reasoningParserFor(model: string): string | undefined {
	const m = model.toLowerCase()
	if (/qwen3(?!.*coder)/.test(m)) return 'qwen3'
	if (m.includes('deepseek-r1') || m.includes('deepseek_r1')) return 'deepseek_r1'
	return undefined
}

/**
 * The command(s) to get `provider` serving `model`, or undefined for providers nobody launches locally.
 * Multi-line output is intentional — each line is a step, shown in one copyable block.
 */
export function launchCommandFor(provider: string, model?: string, opts: { contextWindow?: number; requiresKey?: boolean } = {}): string | undefined {
	if (provider === 'ollama') {
		// The daemon serves every pulled model; context length is a per-model (Modelfile) concern there.
		return model ? `ollama serve\nollama pull ${model}` : 'ollama serve'
	}
	if (provider === 'vllm') {
		if (!model) return 'vllm serve <model-id>  # pick a model first — vLLM serves exactly one'
		const reasoning = reasoningParserFor(model)
		return [
			'vllm serve',
			model,
			'--enable-auto-tool-choice',
			`--tool-call-parser ${toolParserFor(model)}`,
			...(reasoning ? [`--reasoning-parser ${reasoning}`] : []),
			...(opts.contextWindow ? [`--max-model-len ${opts.contextWindow}`] : []),
			...(opts.requiresKey ? ['--api-key $VLLM_API_KEY'] : []),
		].join(' ')
	}
	return undefined // hosted providers are not something the user starts
}

/** Where the provider is expected to listen — for the "nothing is answering at …" message. */
export const LOCAL_PROVIDER_ORIGINS: Record<string, string> = {
	ollama: 'http://127.0.0.1:11434',
	vllm: 'http://127.0.0.1:8000',
}
