// Studio Manager — composition root. Auth gate first (round 9): until /api/auth/me answers, nothing but
// the sign-in screen exists. After that: NavBar + three views switched via useHistoryView (house rule —
// Back works, no router). Views own their data; App owns only session + navigation + theme.

import { useCallback, useEffect, useState } from 'react'
import { LayoutDashboard, Moon, PenTool, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NavBar } from '@/components/blocks/NavBar'
import { useHistoryView } from '@/lib/useHistoryView'
import { api } from '@/lib/api'
import { DashboardView } from '@/components/DashboardView'
import { ClientsView } from '@/components/ClientsView'
import { InvoicesView } from '@/components/InvoicesView'
import { LoginView } from '@/components/LoginView'

type View = 'dashboard' | 'clients' | 'invoices'

export default function App() {
	const [view, setView] = useHistoryView<View>('dashboard')
	const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light') // dark by default
	// null = checking the session, false = signed out, string = the signed-in email.
	const [me, setMe] = useState<string | null | false>(null)

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])

	const checkSession = useCallback(() => {
		api<{ email: string }>('GET', '/api/auth/me')
			.then((u) => setMe(u.email))
			.catch(() => setMe(false))
	}, [])
	useEffect(checkSession, [checkSession])

	const signOut = () => {
		void api('POST', '/api/auth/logout').catch(() => {})
		setMe(false)
	}

	if (me === null) return <main className="min-h-screen bg-background" /> // one silent frame while /me answers
	if (me === false) return <LoginView onSignedIn={(email) => setMe(email)} />

	const navButton = (target: View, label: string) => (
		<button
			type="button"
			onClick={() => setView(target)}
			className={view === target ? 'text-sm font-medium text-foreground' : 'text-sm text-muted-foreground transition-colors hover:text-foreground'}
		>
			{label}
		</button>
	)

	return (
		<main className="min-h-screen bg-background text-foreground">
			<NavBar
				brand={
					<span className="flex items-center gap-2">
						<PenTool className="size-4 text-primary" /> Studio Manager
					</span>
				}
				links={
					<>
						{navButton('dashboard', 'Dashboard')}
						{navButton('clients', 'Clients')}
						{navButton('invoices', 'Invoices')}
					</>
				}
				actions={
					<>
						<span className="hidden text-xs text-muted-foreground sm:inline">{me}</span>
						<Button variant="ghost" size="sm" onClick={signOut}>
							Sign out
						</Button>
						<Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setDark((d) => !d)}>
							{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</Button>
					</>
				}
			/>
			<div className="mx-auto max-w-6xl px-6 py-10">
				{view === 'dashboard' && <DashboardView icon={LayoutDashboard} />}
				{view === 'clients' && <ClientsView />}
				{view === 'invoices' && <InvoicesView />}
			</div>
		</main>
	)
}
