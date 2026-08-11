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
					<Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setDark((d) => !d)}>
						{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</Button>
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
