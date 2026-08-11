// Gallery entry — the old demo shell, alive HERE and only here (this dir never ships to projects).
// It is the preset review gate (ADR-057): author a preset, open /demo/, judge light + dark.

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Moon, Sparkles, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NavBar } from '@/components/blocks/NavBar'
import { useHistoryView } from '@/lib/useHistoryView'
import { GalleryKit } from './GalleryKit'
import { GalleryLanding } from './GalleryLanding'
import '@/index.css'

// PRESET SWITCHER — demo-only (this file never ships): ?preset=<name> loads that theme AFTER index.css,
// so its :root/.dark declarations win and the whole gallery re-skins. Real apps keep the one-@import
// mechanism; this exists so authoring sessions can flip presets from the URL and screenshot each.
const PRESETS = import.meta.glob('/src/themes/*.css', { query: '?url', import: 'default', eager: true }) as Record<string, string>
const presetNames = Object.keys(PRESETS).map((p) => p.replace('/src/themes/', '').replace('.css', ''))
const activePreset = new URLSearchParams(location.search).get('preset') ?? 'premium'
{
	const url = PRESETS[`/src/themes/${activePreset}.css`]
	if (url && activePreset !== 'premium') {
		const link = document.createElement('link')
		link.rel = 'stylesheet'
		link.href = url
		document.head.appendChild(link)
	}
}

type View = 'landing' | 'kit'

function DemoApp() {
	const [view, setView] = useHistoryView<View>('landing')
	const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])

	const link = (target: View, label: string) => (
		<button
			type="button"
			onClick={() => setView(target)}
			className={`text-sm transition-colors ${view === target ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
		>
			{label}
		</button>
	)

	return (
		<main className="min-h-screen bg-background text-foreground">
			<NavBar
				brand={
					<>
						<Sparkles className="size-4 text-primary" /> Meridian
					</>
				}
				links={
					<>
						{link('landing', 'The look')}
						{link('kit', 'The kit')}
					</>
				}
				actions={
					<>
						<select
							aria-label="Theme preset"
							className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
							value={activePreset}
							onChange={(e) => {
								const q = new URLSearchParams(location.search)
								q.set('preset', e.target.value)
								location.search = q.toString()
							}}
						>
							{presetNames.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
						<Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setDark((d) => !d)}>
							{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</Button>
					</>
				}
			/>
			{view === 'landing' ? <GalleryLanding /> : <GalleryKit />}
		</main>
	)
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<DemoApp />
	</StrictMode>,
)
