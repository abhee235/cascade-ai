// modelManager.ts — the extension's model-manager backend, ported from the server's modelCaps (the web
// manager's logic): a provider catalog with configured-status, LIVE model listing for every provider
// (Ollama → /api/tags + /api/show probe; OpenAI-compatible → /v1/models with the key), and hosted
// context/capabilities from core's shared modelSpecs table — so the extension panel shows exactly what
// the web manager would.
//
// The extension has no registry files: VS Code SETTINGS are the store, and the provider's config-change
// listener rebuilds the session (history carried) when they change.

import { archContextLength, ARCH_FALLBACK_CAP, limitsFor, specCapabilities } from '@cascade/core'

/** Default origins + conventional key env vars per provider (mirrors the server's modelCaps). */
export const BASE_URLS: Record<string, string> = {
	ollama: 'http://127.0.0.1:11434',
	openai: 'https://api.openai.com',
	nvidia: 'https://integrate.api.nvidia.com',
	groq: 'https://api.groq.com/openai',
	openrouter: 'https://openrouter.ai/api',
}
const KEY_ENV: Record<string, string> = {
	openai: 'OPENAI_API_KEY',
	nvidia: 'NVIDIA_API_KEY',
	groq: 'GROQ_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
}

/** Resolve the API key for a provider, most-explicit first: the encrypted SecretStorage key set via the
 *  panel, then the cascade.apiKey setting (active provider only — legacy), then the conventional env var,
 *  then CASCADE_API_KEY. */
export function keyFor(provider: string, settingsKey?: string, secret?: string): string | undefined {
	return secret?.trim() || settingsKey?.trim() || process.env[KEY_ENV[provider] ?? ''] || process.env.CASCADE_API_KEY || undefined
}

/** Known default models per hosted provider — what the panel shows BEFORE a key exists, so the catalog is
 *  never an empty table. Context/capabilities resolve through core's shared modelSpecs, so the numbers here
 *  are identical to the web UI's. Once a key is set, the live /v1/models listing replaces this. */
export const DEFAULT_MODELS: Record<string, string[]> = {
	// Popular pullable local models (shown as "Available to pull" next to the installed list).
	ollama: ['qwen3:8b', 'qwen3:4b', 'qwen2.5-coder:7b', 'llama3.2:3b', 'llama3.3:70b', 'gemma3:12b', 'gemma3:4b', 'deepseek-r1:14b', 'mistral:7b', 'nomic-embed-text'],
	openai: ['gpt-5.6-luna', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
	groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-coder-32b', 'deepseek-r1-distill-llama-70b'],
	nvidia: ['meta/llama-3.3-70b-instruct', 'qwen/qwen2.5-coder-32b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'deepseek-ai/deepseek-r1'],
	openrouter: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-coder-32b-instruct', 'deepseek/deepseek-r1'],
}

export interface ProviderEntry {
	id: string
	/** Usable now: local (ollama), or a key is present (setting or env). */
	configured: boolean
}

/** The provider menu, with configured-status — same rule as the server's providerCatalog. */
export function providerCatalog(activeProvider: string, settingsKey?: string, secrets?: Map<string, string>): ProviderEntry[] {
	return Object.keys(BASE_URLS).map((id) => ({
		id,
		configured: id === 'ollama' || !!keyFor(id, id === activeProvider ? settingsKey : undefined, secrets?.get(id)),
	}))
}

export function isOllamaLike(provider: string): boolean {
	return provider === 'ollama' || provider === 'llamacpp'
}

const base = (provider: string, baseUrl?: string): string =>
	(baseUrl?.trim() || BASE_URLS[provider] || '').replace(/\/$/, '')

export interface DetailedModel {
	name: string
	size?: string
	contextWindow?: number
	capabilities: string[]
}

export interface CatalogEntry {
	name: string
	size?: string
}

/** Installed models from Ollama /api/tags (names + sizes only — the cheap listing for the dropdown). */
export async function listOllamaModels(baseUrl?: string): Promise<CatalogEntry[]> {
	try {
		const res = await fetch(`${base('ollama', baseUrl).replace(/\/v1$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) })
		const j = (await res.json()) as { models?: { name: string; size?: number }[] }
		return (j.models ?? []).map((m) => ({ name: m.name, size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined }))
	} catch {
		return []
	}
}

export interface ModelInfoLite {
	capabilities: string[]
	contextWindow?: number
	archMax?: number
}

/** Context window + capabilities for one Ollama model (Modelfile num_ctx, else capped arch ceiling —
 *  core's exact detectModelLimits rule). */
export async function ollamaModelInfo(model: string, baseUrl?: string): Promise<ModelInfoLite> {
	try {
		const res = await fetch(`${base('ollama', baseUrl).replace(/\/v1$/, '')}/api/show`, {
			method: 'POST',
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(5000),
		})
		const j = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown>; capabilities?: string[] }
		const m = (j.parameters ?? '').match(/^\s*num_ctx\s+(\d+)/m)
		const archMax = archContextLength(j.model_info)
		let contextWindow: number | undefined
		if (m) contextWindow = Number(m[1])
		else if (archMax) contextWindow = Math.min(archMax, ARCH_FALLBACK_CAP)
		return { capabilities: j.capabilities ?? [], contextWindow, archMax }
	} catch {
		return { capabilities: [] }
	}
}

/** The panel's table for ANY provider. Ollama: live tags + per-model probe. OpenAI-compatible: /v1/models
 *  with the key, context/capabilities from the shared modelSpecs table. Empty + reason on failure. */
const specRows = (provider: string, ids: string[]): DetailedModel[] =>
	ids.map((id) => ({ name: id, contextWindow: limitsFor(provider, id).contextMax, capabilities: specCapabilities(id) ?? [] }))

export async function listModelsDetailed(
	provider: string,
	baseUrl?: string,
	settingsKey?: string,
	secret?: string,
): Promise<{ rows: DetailedModel[]; suggestions?: DetailedModel[]; error?: string; note?: string }> {
	if (isOllamaLike(provider)) {
		const models = await listOllamaModels(baseUrl)
		// Curated pullable catalog, minus families already installed (an installed qwen3:30b hides the
		// qwen3:* suggestions — the user already chose their size for that family).
		const installedFamilies = new Set(models.map((m) => m.name.split(':')[0]!.toLowerCase()))
		const suggestions = specRows('ollama', (DEFAULT_MODELS.ollama ?? []).filter((id) => !installedFamilies.has(id.split(':')[0]!.toLowerCase())))
		if (models.length === 0) {
			return { rows: [], suggestions, error: `No installed models — is Ollama running${baseUrl ? ` at ${baseUrl}` : ''}? Pull one below, or \`ollama pull <model>\`.` }
		}
		const rows = await Promise.all(
			models.map(async (m) => {
				const info = await ollamaModelInfo(m.name, baseUrl)
				return { name: m.name, size: m.size, contextWindow: info.contextWindow, capabilities: info.capabilities }
			}),
		)
		return { rows, suggestions }
	}
	const origin = base(provider, baseUrl)
	if (!origin) return { rows: [], error: `Unknown provider "${provider}" — set a base URL.` }
	const key = keyFor(provider, settingsKey, secret)
	const defaults = DEFAULT_MODELS[provider] ?? []
	if (!key) {
		// No key yet: show the KNOWN default catalog (shared modelSpecs values) instead of an empty table.
		return {
			rows: specRows(provider, defaults),
			note: `Showing known ${provider} models (official specs). Set an API key to list your account's live models.`,
		}
	}
	try {
		const res = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
		if (!res.ok) return { rows: specRows(provider, defaults), error: `${provider} /v1/models answered ${res.status} — is the key valid? Showing known defaults.` }
		const j = (await res.json()) as { data?: { id: string }[] }
		const rows = (j.data ?? [])
			.map((m) => m.id)
			.sort()
			.map((id) => {
				const limits = limitsFor(provider, id)
				return { name: id, contextWindow: limits.contextMax, capabilities: specCapabilities(id) ?? [] }
			})
		return rows.length ? { rows } : { rows: specRows(provider, defaults), note: 'Account listing was empty — showing known defaults.' }
	} catch (e) {
		return { rows: specRows(provider, defaults), error: `${provider} unreachable (${e instanceof Error ? e.message : String(e)}) — showing known defaults.` }
	}
}
