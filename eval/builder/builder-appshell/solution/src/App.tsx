// SOLUTION EXEMPLAR — the shape builder-appshell is measured against.
//
// Two things carry the fixture. First, auth renders OUTSIDE the shell: a sign-in screen has nothing to
// navigate to, so it gets no nav and no footer. Second, the states page shows all four side by side —
// loading, empty, error, 404 — because the measured failure is an app that ships only the data state and
// then says "no results" when a request actually failed.

import { useMemo, useState } from 'react'
import { FileText, LayoutDashboard, RefreshCw, SearchX, Settings, ShieldAlert, Sparkles } from 'lucide-react'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { AppShell } from '@/components/blocks/AppShell'
import { AuthCard } from '@/components/blocks/AuthCard'
import { EmptyState } from '@/components/blocks/EmptyState'
import { ErrorState } from '@/components/blocks/ErrorState'
import { FilterBar } from '@/components/blocks/FilterBar'
import { SettingRow } from '@/components/blocks/SettingRow'
import { SkeletonList } from '@/components/blocks/SkeletonList'

const DOCS = [
	{ id: 'd1', name: 'Q3 revenue model', owner: 'Priya Raman' },
	{ id: 'd2', name: 'Onboarding rewrite', owner: 'Sam Okafor' },
	{ id: 'd3', name: 'Pricing experiment brief', owner: 'Priya Raman' },
	{ id: 'd4', name: 'Churn cohort analysis', owner: 'Lena Fischer' },
	{ id: 'd5', name: 'Supplier contract 2026', owner: 'Marco Salas' },
	{ id: 'd6', name: 'Brand guidelines', owner: 'Aisha Bello' },
	{ id: 'd7', name: 'Hiring plan', owner: 'Sam Okafor' },
	{ id: 'd8', name: 'Incident postmortem 04-02', owner: 'Lena Fischer' },
]

type View = 'settings' | 'search' | 'states'

export default function App() {
	const [signedIn, setSignedIn] = useState(false)
	const [email, setEmail] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [view, setView] = useState<View>('settings')
	const [query, setQuery] = useState('')

	const results = useMemo(() => {
		const q = query.trim().toLowerCase()
		return q ? DOCS.filter((d) => `${d.name} ${d.owner}`.toLowerCase().includes(q)) : DOCS
	}, [query])

	// Auth carries the brand and NOTHING else — no shell around it.
	if (!signedIn) {
		return (
			<AuthCard
				brand={
					<>
						<Sparkles className="size-5 text-primary" /> Ledger
					</>
				}
				title="Welcome back"
				subtitle="Sign in to reach your documents."
				error={error ?? undefined}
				footer={<>Every document you own stays yours.</>}
			>
				<form
					noValidate
					onSubmit={(e) => {
						e.preventDefault() // validate on SUBMIT; noValidate so OUR message shows, not the browser's
						if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
							setError('That does not look like an email address.')
							return
						}
						setError(null)
						setSignedIn(true)
					}}
					className="flex flex-col gap-4"
				>
					<div className="grid gap-1.5">
						<Label htmlFor="email">Email</Label>
						<Input id="email" type="email" value={email} aria-invalid={!!error} onChange={(e) => setEmail(e.target.value)} />
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="password">Password</Label>
						<Input id="password" type="password" />
					</div>
					<Button type="submit" className="w-full">
						Sign in
					</Button>
				</form>
			</AuthCard>
		)
	}

	return (
		<AppShell
			brand={
				<>
					<Sparkles className="size-4 text-primary" /> Ledger
				</>
			}
			groups={[
				{
					items: [
						{ label: 'Settings', icon: Settings, active: view === 'settings', onClick: () => setView('settings') },
						{ label: 'Search', icon: FileText, active: view === 'search', onClick: () => setView('search') },
						{ label: 'States', icon: LayoutDashboard, active: view === 'states', onClick: () => setView('states') },
					],
				},
			]}
			user={
				<button type="button" className="text-left text-sm text-muted-foreground hover:text-foreground" onClick={() => setSignedIn(false)}>
					Sign out
				</button>
			}
			header={<span className="font-medium">{view === 'settings' ? 'Settings' : view === 'search' ? 'Search' : 'States'}</span>}
		>
			{view === 'settings' ? (
				<div className="flex flex-col gap-8">
					<div className="flex flex-col gap-3">
						<h2 className="text-sm font-medium text-muted-foreground">Preferences</h2>
						<div className="divide-y rounded-xl border bg-card">
							<SettingRow
								label="Theme"
								description="Match your system, or pin one."
								control={
									<Select defaultValue="system">
										<SelectTrigger className="w-36">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="system">System</SelectItem>
											<SelectItem value="light">Light</SelectItem>
											<SelectItem value="dark">Dark</SelectItem>
										</SelectContent>
									</Select>
								}
							/>
							<SettingRow label="Compact rows" description="Fit more documents on screen." control={<Switch />} />
						</div>
					</div>
					{/* Destructive work is separated, labelled, AND confirmed. */}
					<div className="flex flex-col gap-3">
						<h2 className="text-sm font-medium text-muted-foreground">Danger zone</h2>
						<div className="rounded-xl border border-destructive/40 bg-card">
							<SettingRow
								label="Delete account"
								description="Removes your profile and every document you own. This cannot be undone."
								control={
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button variant="destructive" size="sm">
												Delete
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>Delete your account?</AlertDialogTitle>
												<AlertDialogDescription>
													This permanently removes your profile and all {DOCS.length} documents you own. Teammates lose access immediately. This cannot be undone.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>Keep my account</AlertDialogCancel>
												<AlertDialogAction variant="destructive">Delete everything</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								}
							/>
						</div>
					</div>
				</div>
			) : view === 'search' ? (
				<div className="flex flex-col gap-6">
					<FilterBar query={query} onQueryChange={setQuery} placeholder="Search documents…" onClear={query ? () => setQuery('') : undefined} />
					{results.length === 0 ? (
						// FILTERED-empty: the way out is "clear", never "create your first" — the document exists.
						<EmptyState
							icon={SearchX}
							title="No matches"
							description="No document matches that search."
							action={
								<Button variant="outline" onClick={() => setQuery('')}>
									Clear search
								</Button>
							}
						/>
					) : (
						<div className="divide-y rounded-xl border bg-card">
							{results.map((d) => (
								<div key={d.id} className="flex items-center justify-between gap-4 p-4">
									<span className="text-sm font-medium">{d.name}</span>
									<span className="text-sm text-muted-foreground">{d.owner}</span>
								</div>
							))}
						</div>
					)}
				</div>
			) : (
				<div className="grid items-start gap-6 lg:grid-cols-2">
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium text-muted-foreground">Loading</span>
						<SkeletonList count={3} />
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium text-muted-foreground">Empty — it worked, there is nothing yet</span>
						<EmptyState icon={FileText} title="No documents yet" description="Create one and it will show up here." action={<Button>New document</Button>} />
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium text-muted-foreground">Error — it failed; the action RETRIES</span>
						<ErrorState
							icon={ShieldAlert}
							title="Couldn't load your documents"
							description="The request timed out. Your work is safe."
							action={
								<Button variant="outline">
									<RefreshCw className="size-4" /> Try again
								</Button>
							}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium text-muted-foreground">404 — the route is gone; the action LEAVES</span>
						<ErrorState code="404" title="We can't find that page" description="It may have been moved or deleted." action={<Button onClick={() => setView('settings')}>Back to settings</Button>} />
					</div>
				</div>
			)}
		</AppShell>
	)
}
