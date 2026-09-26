// The BLANK composition root — your app replaces everything marked data-placeholder (the TemplateAudit
// tool holds you to it; "done" requires zero placeholders left). House architecture, keep it: App stays a
// small composition root; views switch via a discriminated union through useHistoryView (browser
// back/forward works, no router); pages are assembled from blocks (src/components/blocks) + the ui kit,
// styled ONLY with design tokens. The dark-mode block below is load-bearing — carry it into your rewrite.

import { useEffect, useState } from 'react'
import { Moon, Rocket, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/blocks/EmptyState'
import { NavBar } from '@/components/blocks/NavBar'
import { useHistoryView } from '@/lib/useHistoryView'

// Grow this union as you add views, e.g. 'catalog' | 'detail' | 'cart' — or object entries like
// { kind: 'detail', id: string } (must stay serializable; see src/lib/useHistoryView.ts).
type View = 'home'

export default function App() {
	// useHistoryView (not useState) for the top-level view — the house rule that keeps Back working.
	// Destructure setView too once you have navigation: const [view, setView] = useHistoryView<View>('home')
	const [view] = useHistoryView<View>('home')
	const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])

	return (
		<main className="min-h-screen bg-background text-foreground">
			<NavBar
				brand={
					<span data-placeholder="brand">
						<Rocket className="size-4 text-primary" /> App
					</span>
				}
				actions={
					<Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setDark((d) => !d)}>
						{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</Button>
				}
			/>
			{view === 'home' && (
				<div data-placeholder="scaffold" className="mx-auto max-w-6xl px-6 py-16">
					<EmptyState
						icon={Rocket}
						title="Blank scaffold"
						description="This screen is the placeholder the builder replaces with your app's first real view."
					/>
				</div>
			)}
		</main>
	)
}
