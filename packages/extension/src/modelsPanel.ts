// modelsPanel.ts — the "Language Models" EDITOR-AREA panel (an editor-area overlay), multi-provider like
// the web ModelManager: a provider rail (configured-status dots), live model table per provider (Ollama
// probe or /v1/models + shared modelSpecs), per-row Use / Utility, and the real VS Code Settings for
// keys/params. Webview panel styled purely with VS Code CSS variables; singleton (reopen = reveal).

import * as vscode from 'vscode'
import { listModelsDetailed, providerCatalog, type DetailedModel } from './modelManager'
import { modelsPanelHtml } from './modelsPanelHtml'

export interface ModelsPanelDeps {
	getSettings(): { provider: string; model: string; baseUrl: string; utilityModel: string; apiKey: string; secrets: Map<string, string> }
	/** Persist a settings patch (same path the composer dropdown uses). */
	apply(patch: Record<string, string>): Promise<void>
	/** Prompt for + store a provider's API key in SecretStorage (native input box). */
	setKey(provider: string): Promise<void>
	/** The curated enabled list (ADR-067) — what the composer dropdown shows. */
	enabled(): { provider: string; model: string; contextWindow?: number }[]
	addModel(provider: string, model: string, contextWindow?: number): Promise<void>
	removeModel(provider: string, model: string): Promise<void>
	/** Activate a curated model (writes provider/model + its saved params to settings). */
	activate(provider: string, model: string): Promise<void>
}

let panel: vscode.WebviewPanel | undefined

export function openModelsPanel(deps: ModelsPanelDeps): void {
	if (panel) {
		panel.reveal()
		void refresh(deps)
		return
	}
	panel = vscode.window.createWebviewPanel('cascadeModels', 'Language Models', vscode.ViewColumn.One, {
		enableScripts: true,
		retainContextWhenHidden: true,
	})
	panel.onDidDispose(() => {
		panel = undefined
	})
	panel.webview.html = modelsPanelHtml()
	panel.webview.onDidReceiveMessage(async (msg: { type: string; name?: string; provider?: string }) => {
		try {
			if (msg.type === 'load' || msg.type === 'refresh') await refresh(deps, msg.provider)
			else if (msg.type === 'use' && msg.name) {
				// Activate: switches provider AND model together and applies the model's saved params
				// (web behavior). Not-yet-curated models are added first, so "Use" always works.
				const provider = msg.provider ?? deps.getSettings().provider
				await deps.addModel(provider, msg.name)
				await deps.activate(provider, msg.name)
				await refresh(deps, msg.provider)
			} else if (msg.type === 'add' && msg.name) {
				await deps.addModel(msg.provider ?? deps.getSettings().provider, msg.name)
				await refresh(deps, msg.provider)
			} else if (msg.type === 'removeModel' && msg.name) {
				await deps.removeModel(msg.provider ?? deps.getSettings().provider, msg.name)
				await refresh(deps, msg.provider)
			} else if (msg.type === 'utility' && msg.name) {
				const current = deps.getSettings().utilityModel
				await deps.apply({ utilityModel: current === msg.name ? '' : msg.name }) // toggle
				await refresh(deps, msg.provider)
			} else if (msg.type === 'setKey' && msg.provider) {
				await deps.setKey(msg.provider)
				await refresh(deps, msg.provider)
			} else if (msg.type === 'pull' && msg.name) {
				// Run the pull in a REAL terminal so the download progress is visible and cancellable.
				// Name is sanitized — it can only be one registry id, never a compound command.
				const name = msg.name.replace(/[^\w.:\/-]/g, '')
				const term = vscode.window.createTerminal(`ollama pull ${name}`)
				term.show()
				term.sendText(`ollama pull ${name}`)
			} else if (msg.type === 'openSettings') {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'cascade.')
			}
		} catch (e) {
			void panel?.webview.postMessage({ type: 'data', rows: [], providers: [], viewing: 'ollama', active: '', utility: '', error: e instanceof Error ? e.message : String(e) })
		}
	})
	void refresh(deps)
}

async function refresh(deps: ModelsPanelDeps, viewProvider?: string): Promise<void> {
	if (!panel) return
	const s = deps.getSettings()
	const viewing = viewProvider ?? s.provider
	const providers = providerCatalog(s.provider, s.apiKey, s.secrets)
	// Key precedence per tab: its SecretStorage key → the settings key (active provider only) → env vars.
	const { rows, suggestions, error, note } = await listModelsDetailed(viewing, viewing === s.provider ? s.baseUrl : undefined, viewing === s.provider ? s.apiKey : undefined, s.secrets.get(viewing))
	void panel.webview.postMessage({
		type: 'data',
		rows,
		suggestions,
		providers,
		viewing,
		activeProvider: s.provider,
		active: s.model,
		utility: s.utilityModel,
		enabled: deps.enabled(), // "Your models" — the curated list the dropdown shows
		error,
		note,
	})
}
