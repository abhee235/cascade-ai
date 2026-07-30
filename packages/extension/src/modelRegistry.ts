// modelRegistry.ts — the ENABLED models (ADR-067), ported from the server's modelRegistry so the
// extension behaves exactly like the web manager: the composer dropdown shows ONLY this curated list —
// a small user-built set that SPANS PROVIDERS — not a provider's entire catalog. The Language Models
// panel browses the full catalog and ADDS models here.
//
// Storage differs from the server (no project dir): the list lives in VS Code globalState (per install,
// like the server's install-wide .cascade/models.json), and API keys never live here at all — they are
// in SecretStorage. The ACTIVE selection stays in settings (cascade.provider/model), which is what the
// session builder already reads; activating a model also applies its saved params to settings, exactly
// as the server applies params on switch.

/** The slice of vscode.Memento we need — narrowed so tests can pass a plain fake. */
export interface StateStore {
	get<T>(key: string): T | undefined
	update(key: string, value: unknown): Thenable<void> | Promise<void>
}

export interface EnabledModel {
	provider: string
	model: string
	/** Context-window override (tokens) applied when this model is activated. */
	contextWindow?: number
	/** Cap on generated tokens per turn. */
	maxOutputTokens?: number
	temperature?: number
	topP?: number
	topK?: number
	/** ADR-076: custom OpenAI-compatible endpoint (rented vLLM / remote Ollama) applied on activation. */
	baseUrl?: string
	/** ADR-077: wire protocol for a custom endpoint — 'ollama' forces the native adapter. */
	api?: 'openai' | 'ollama'
}

/** The editable per-model params (everything except identity). */
export type ModelParams = Omit<EnabledModel, 'provider' | 'model'>

const KEY = 'cascade.enabledModels'

/** Seed set — sane defaults across providers; the user curates from here (mirrors the server's DEFAULTS). */
const DEFAULTS: EnabledModel[] = [
	{ provider: 'ollama', model: 'qwen36-agentic:latest' },
	{ provider: 'openai', model: 'gpt-5.6-luna' },
	{ provider: 'openai', model: 'gpt-4.1' },
]

const same = (a: EnabledModel, provider: string, model: string) => a.provider === provider && a.model === model

export class ModelRegistry {
	constructor(private readonly state: StateStore) {}

	/** The enabled models, optionally ensuring `ensure` (the active model) is present so the picker never
	 *  hides what is actually running. */
	list(ensure?: { provider: string; model: string }): EnabledModel[] {
		const stored = this.state.get<EnabledModel[]>(KEY)
		// An EMPTY stored list is a real user state (they removed everything) — only an absent key seeds
		// the defaults, otherwise removing your last model would resurrect them.
		const list = Array.isArray(stored) ? stored : [...DEFAULTS]
		if (ensure?.model && !list.some((m) => same(m, ensure.provider, ensure.model))) {
			return [...list, { provider: ensure.provider, model: ensure.model }]
		}
		return list
	}

	async add(entry: EnabledModel): Promise<void> {
		const list = this.list()
		const existing = list.find((m) => same(m, entry.provider, entry.model))
		if (existing) {
			// MERGE, never clobber: adding an already-curated model (e.g. clicking Add again, or Use on a
			// catalog row) must not wipe params the user set — only fields actually provided are applied.
			const target = existing as unknown as Record<string, unknown>
			for (const [k, v] of Object.entries(entry)) {
				if (v !== undefined && k !== 'provider' && k !== 'model') target[k] = v
			}
		} else list.push(entry)
		await this.state.update(KEY, list)
	}

	async remove(provider: string, model: string): Promise<void> {
		await this.state.update(
			KEY,
			this.list().filter((m) => !same(m, provider, model)),
		)
	}

	/** Merge editable params onto a model (adding it if absent). Fields omitted from `params` are left
	 *  untouched; fields present but undefined CLEAR the override. */
	async setParams(provider: string, model: string, params: ModelParams): Promise<void> {
		const list = this.list()
		let m = list.find((x) => same(x, provider, model))
		if (!m) {
			m = { provider, model }
			list.push(m)
		}
		const target = m as unknown as Record<string, unknown>
		for (const k of ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'baseUrl', 'api'] as const) {
			if (k in params) target[k] = params[k]
		}
		await this.state.update(KEY, list)
	}

	/** The full param set for a model (applied on activation). Empty when the model isn't curated. */
	paramsFor(provider: string, model: string): ModelParams {
		const m = this.list().find((x) => same(x, provider, model))
		if (!m) return {}
		const { provider: _p, model: _m, ...params } = m
		return params
	}

	has(provider: string, model: string): boolean {
		return this.list().some((m) => same(m, provider, model))
	}
}
