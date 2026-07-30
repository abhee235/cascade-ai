// modelsPanelHtml.ts — the Language Models panel document. NO vscode import: loadable by the browser
// harness (harness/models.html) and tests, so the overlay gets driven before it ever reaches VS Code.

export function modelsPanelHtml(): string {
	// Vanilla JS on purpose: one table + a provider rail — no bundler; VS Code vars do the theming.
	return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; }
	.bar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder, var(--vscode-input-border)); border-radius: 4px; padding: 5px 10px; }
	.search input { flex: 1; background: transparent; border: none; outline: none; color: var(--vscode-input-foreground); font-size: 13px; }
	button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12.5px; }
	button:hover { background: var(--vscode-list-hoverBackground); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
	.tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
	.tab { border: 1px solid transparent; background: transparent; padding: 4px 12px; border-radius: 4px; display: flex; align-items: center; gap: 6px; }
	.tab.on { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-disabledForeground); }
	.dot.ok { background: var(--vscode-charts-green, #89d185); }
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	th { text-align: left; font-weight: 600; padding: 8px 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
	td { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
	tr:hover td { background: var(--vscode-list-hoverBackground); }
	.name { font-family: var(--vscode-editor-font-family, monospace); }
	.badge { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 11px; margin-right: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.tag-active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.dim { opacity: 0.6; }
	.rowbtn { padding: 2px 9px; font-size: 11.5px; margin-left: 4px; }
	.err { margin: 12px 2px; padding: 8px 12px; border-radius: 4px; background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.08)); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); font-size: 12.5px; }
	.hint { margin-top: 14px; font-size: 12px; opacity: 0.6; }
	.section { font-size: 13px; font-weight: 600; margin: 6px 0 6px; }
	.prov { display: inline-block; min-width: 74px; font-size: 11px; opacity: 0.7; }
</style>
</head>
<body>
	<div class="bar">
		<div class="search">🔎&nbsp;<input id="q" type="text" placeholder="Type to search…" /></div>
		<button id="setkey" style="display:none">🔑 Set API key</button>
		<button id="refresh">Refresh</button>
		<button class="primary" id="settings">⚙ Open Cascade Settings</button>
	</div>
	<div class="section">Your models <span class="dim" style="font-weight:400">— what the composer dropdown lists (all providers)</span></div>
	<table><tbody id="yours"></tbody></table>
	<div class="section" style="margin-top:20px">Add models <span class="dim" style="font-weight:400">— browse a provider and add to your list</span></div>
	<div class="tabs" id="tabs"></div>
	<div id="note" class="err" style="display:none; background: var(--vscode-editorWidget-background); border-color: var(--vscode-panel-border); opacity: 0.85"></div>
	<div id="err" class="err" style="display:none"></div>
	<table>
		<thead><tr><th style="width:40%">Name</th><th>Context Size</th><th>Capabilities</th><th>Size</th><th style="width:140px"></th></tr></thead>
		<tbody id="rows"></tbody>
	</table>
	<div class="hint">Use = main model (picking one under another provider tab switches provider too) · Utility = side-queries. Applies from the next message — the conversation is kept. Local models: <code>ollama pull &lt;model&gt;</code>. Keys, base URLs and sampling live in Settings.</div>
	<script>
		const vscode = acquireVsCodeApi()
		let data = { rows: [], providers: [], viewing: 'ollama', activeProvider: '', active: '', utility: '' }
		const q = document.getElementById('q')
		q.addEventListener('input', renderRows)
		document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh', provider: data.viewing }))
		document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }))
		document.getElementById('setkey').addEventListener('click', () => vscode.postMessage({ type: 'setKey', provider: data.viewing }))
		window.addEventListener('message', (e) => {
			if (e.data.type !== 'data') return
			data = e.data
			const err = document.getElementById('err')
			err.style.display = e.data.error ? 'block' : 'none'
			err.textContent = e.data.error ?? ''
			const note = document.getElementById('note')
			note.style.display = e.data.note ? 'block' : 'none'
			note.textContent = e.data.note ?? ''
			// The key button applies to hosted providers only (ollama needs no key).
			const setkey = document.getElementById('setkey')
			const hosted = data.viewing !== 'ollama' && data.viewing !== 'llamacpp'
			setkey.style.display = hosted ? 'inline-block' : 'none'
			const configured = (data.providers.find((p) => p.id === data.viewing) || {}).configured
			setkey.textContent = configured ? '🔑 Change API key' : '🔑 Set API key'
			renderTabs()
			renderYours()
			renderRows()
		})
		function renderYours() {
			const body = document.getElementById('yours')
			body.innerHTML = ''
			for (const m of data.enabled || []) {
				const isActive = m.model === data.active && m.provider === data.activeProvider
				const tr = document.createElement('tr')
				tr.innerHTML =
					'<td class="name" style="width:52%"><span class="prov">' + m.provider + '</span>' + m.model +
					(isActive ? ' <span class="badge tag-active">active</span>' : '') +
					(m.model === data.utility ? ' <span class="badge">utility</span>' : '') + '</td>' +
					'<td>' + (m.contextWindow ? m.contextWindow.toLocaleString() : '<span class="dim">auto</span>') + '</td>'
				const td = document.createElement('td')
				td.style.textAlign = 'right'
				const use = document.createElement('button')
				use.className = 'rowbtn'
				use.textContent = isActive ? '✓ In use' : 'Use'
				use.disabled = isActive
				use.addEventListener('click', () => vscode.postMessage({ type: 'use', name: m.model, provider: m.provider }))
				const util = document.createElement('button')
				util.className = 'rowbtn'
				util.textContent = m.model === data.utility ? '✕ utility' : 'utility'
				util.title = 'Toggle as the side-query (utility) model'
				util.addEventListener('click', () => vscode.postMessage({ type: 'utility', name: m.model, provider: m.provider }))
				const rm = document.createElement('button')
				rm.className = 'rowbtn'
				rm.textContent = 'Remove'
				rm.title = 'Remove from your list (does not delete the model)'
				rm.disabled = isActive
				rm.addEventListener('click', () => vscode.postMessage({ type: 'removeModel', name: m.model, provider: m.provider }))
				td.append(use, util, rm)
				tr.append(td)
				body.append(tr)
			}
			if (!(data.enabled || []).length) {
				body.innerHTML = '<tr><td class="dim" style="padding:10px 10px">No models yet — add one from a provider below.</td></tr>'
			}
		}
		function renderTabs() {
			const tabs = document.getElementById('tabs')
			tabs.innerHTML = ''
			for (const p of data.providers) {
				const b = document.createElement('button')
				b.className = 'tab' + (p.id === data.viewing ? ' on' : '')
				b.innerHTML = '<span class="dot' + (p.configured ? ' ok' : '') + '"></span>' + p.id + (p.id === data.activeProvider ? ' ✓' : '')
				b.title = p.configured ? 'configured' : 'no API key (set cascade.apiKey or the provider env var)'
				b.addEventListener('click', () => vscode.postMessage({ type: 'refresh', provider: p.id }))
				tabs.append(b)
			}
		}
		function renderRows() {
			const needle = q.value.toLowerCase()
			const body = document.getElementById('rows')
			body.innerHTML = ''
			renderInstalled(body, needle)
			renderSuggestions(body, needle)
		}
		function renderInstalled(body, needle) {
			for (const r of data.rows.filter((r) => r.name.toLowerCase().includes(needle))) {
				const tr = document.createElement('tr')
				const caps = (r.capabilities || []).filter((c) => c !== 'completion')
				const isActive = r.name === data.active && data.viewing === data.activeProvider
				tr.innerHTML =
					'<td class="name">' + r.name +
					(isActive ? ' <span class="badge tag-active">active</span>' : '') +
					(r.name === data.utility ? ' <span class="badge">utility</span>' : '') + '</td>' +
					'<td>' + (r.contextWindow ? r.contextWindow.toLocaleString() : '<span class="dim">—</span>') + '</td>' +
					'<td>' + (caps.length ? caps.map((c) => '<span class="badge">' + c + '</span>').join('') : '<span class="dim">—</span>') + '</td>' +
					'<td>' + (r.size ?? '<span class="dim">—</span>') + '</td>'
				const td = document.createElement('td')
				td.style.textAlign = 'right'
				const curated = (data.enabled || []).some((m) => m.provider === data.viewing && m.model === r.name)
				const add = document.createElement('button')
				add.className = 'rowbtn'
				add.textContent = curated ? '✓ Added' : '+ Add'
				add.disabled = curated
				add.title = 'Add to your models (appears in the composer dropdown)'
				add.addEventListener('click', () => vscode.postMessage({ type: 'add', name: r.name, provider: data.viewing }))
				const use = document.createElement('button')
				use.className = 'rowbtn'
				use.textContent = isActive ? '✓ In use' : 'Use now'
				use.disabled = isActive
				use.title = 'Add (if needed) and switch to this model'
				use.addEventListener('click', () => vscode.postMessage({ type: 'use', name: r.name, provider: data.viewing }))
				td.append(add, use)
				tr.append(td)
				body.append(tr)
			}
		}
		function renderSuggestions(body, needle) {
			const sugg = (data.suggestions || []).filter((r) => r.name.toLowerCase().includes(needle))
			if (!sugg.length) return
			const head = document.createElement('tr')
			head.innerHTML = '<td colspan="5" style="font-weight:600; padding-top:14px; opacity:0.75">Available to pull <span class="dim" style="font-weight:400">— downloads via <code>ollama pull</code> in a terminal; Refresh when done</span></td>'
			body.append(head)
			for (const r of sugg) {
				const tr = document.createElement('tr')
				const caps = (r.capabilities || []).filter((c) => c !== 'completion')
				tr.innerHTML =
					'<td class="name dim">' + r.name + '</td>' +
					'<td class="dim">' + (r.contextWindow ? r.contextWindow.toLocaleString() : '—') + '</td>' +
					'<td>' + (caps.length ? caps.map((c) => '<span class="badge">' + c + '</span>').join('') : '<span class="dim">—</span>') + '</td>' +
					'<td class="dim">—</td>'
				const td = document.createElement('td')
				const pull = document.createElement('button')
				pull.className = 'rowbtn'
				pull.textContent = '⬇ Pull'
				pull.title = 'Download with ollama pull (opens a terminal)'
				pull.addEventListener('click', () => vscode.postMessage({ type: 'pull', name: r.name }))
				td.append(pull)
				tr.append(td)
				body.append(tr)
			}
		}
		vscode.postMessage({ type: 'load' })
	</script>
</body>
</html>`
}
