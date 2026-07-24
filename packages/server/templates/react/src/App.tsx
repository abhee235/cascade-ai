// Starter showcase — replace this with your app (and delete src/demo/). It demonstrates the house
// architecture: App is a small composition root; views switch via a discriminated union; the page is
// assembled from blocks (src/components/blocks) + the ui kit, styled only with design tokens.

import { useEffect, useState } from 'react'
import { Moon, Sparkles, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NavBar } from '@/components/blocks/NavBar'
import { useHistoryView } from '@/lib/useHistoryView'
import { GalleryKit } from '@/demo/GalleryKit'
import { GalleryLanding } from '@/demo/GalleryLanding'

type View = 'landing' | 'kit'

export default function App() {
	// useHistoryView (not useState) for the top-level view → browser + preview back/forward work, no router.
	const [view, setView] = useHistoryView<View>('landing')
	const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])

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
						<button type="button" onClick={() => setView('landing')} className={`text-sm transition-colors ${view === 'landing' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
							The look
						</button>
						<button type="button" onClick={() => setView('kit')} className={`text-sm transition-colors ${view === 'kit' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
							The kit
						</button>
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
