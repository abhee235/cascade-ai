// ClientsView — list (search + pagination), detail, create/edit form, delete with confirm + the 409
// surface (round 11: the API's own "still has invoices" sentence shows instead of removing the row).

import { useCallback, useEffect, useState } from 'react'
import { UserPlus, Users } from 'lucide-react'
import { EmptyState } from '@/components/blocks/EmptyState'
import { ErrorState } from '@/components/blocks/ErrorState'
import { SkeletonList } from '@/components/blocks/SkeletonList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError } from '@/lib/api'
import type { Client, ListEnvelope } from '@/lib/types'

const PER_PAGE = 10

type Mode = { kind: 'list' } | { kind: 'detail'; client: Client } | { kind: 'form'; editing?: Client }

export function ClientsView() {
	const [mode, setMode] = useState<Mode>({ kind: 'list' })
	const [search, setSearch] = useState('')
	const [debounced, setDebounced] = useState('')
	const [page, setPage] = useState(1)
	const [data, setData] = useState<ListEnvelope<Client> | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const t = setTimeout(() => {
			setDebounced(search)
			setPage(1) // search resets to page 1 (round 7's rule)
		}, 300)
		return () => clearTimeout(t)
	}, [search])

	const load = useCallback(() => {
		setError(null)
		setData(null)
		api<ListEnvelope<Client>>('GET', `/api/clients?search=${encodeURIComponent(debounced)}&page=${page}&perPage=${PER_PAGE}`)
			.then(setData)
			.catch((e) => setError(e instanceof Error ? e.message : 'failed to load clients'))
	}, [debounced, page])
	useEffect(load, [load])

	const pages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1

	if (mode.kind === 'form') return <ClientForm editing={mode.editing} onDone={(c) => (c ? setMode({ kind: 'detail', client: c }) : setMode({ kind: 'list' }))} />
	if (mode.kind === 'detail') return <ClientDetail client={mode.client} onBack={() => setMode({ kind: 'list' })} onEdit={() => setMode({ kind: 'form', editing: mode.client })} onDeleted={() => setMode({ kind: 'list' })} />

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-serif text-2xl font-semibold tracking-display">Clients</h1>
				<Button onClick={() => setMode({ kind: 'form' })}>
					<UserPlus className="size-4" /> New client
				</Button>
			</div>
			<Input placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
			{error ? (
				<ErrorState
					title="Couldn't load clients"
					description={error}
					action={
						<Button variant="outline" onClick={load}>
							Retry
						</Button>
					}
				/>
			) : !data ? (
				<SkeletonList shape="rows" count={6} />
			) : data.total === 0 ? (
				debounced ? (
					<EmptyState icon={Users} title="No matches" description={`Nothing matches “${debounced}”.`} action={<Button variant="outline" onClick={() => setSearch('')}>Clear search</Button>} />
				) : (
					<EmptyState icon={Users} title="No clients yet" description="Add your first client to start invoicing." action={<Button onClick={() => setMode({ kind: 'form' })}>New client</Button>} />
				)
			) : (
				<>
					<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
						{data.items.map((c) => (
							<button
								type="button"
								key={c.id}
								onClick={() => setMode({ kind: 'detail', client: c })}
								className="flex w-full items-center justify-between gap-4 border-b px-5 py-3.5 text-left transition-colors last:border-b-0 hover:bg-muted/50"
							>
								<span className="min-w-0">
									<span className="block truncate font-medium">{c.name}</span>
									<span className="block truncate text-sm text-muted-foreground">{c.email}</span>
								</span>
								{c.company ? <Badge variant="secondary">{c.company}</Badge> : null}
							</button>
						))}
					</div>
					<div className="flex items-center justify-between text-sm text-muted-foreground">
						<span>
							Page {page} of {pages}
						</span>
						<span className="flex gap-2">
							<Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
								Previous
							</Button>
							<Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
								Next
							</Button>
						</span>
					</div>
				</>
			)}
		</div>
	)
}

function ClientDetail({ client, onBack, onEdit, onDeleted }: { client: Client; onBack: () => void; onEdit: () => void; onDeleted: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const doDelete = async () => {
		try {
			await api('DELETE', `/api/clients/${client.id}`)
			onDeleted()
		} catch (e) {
			// The 409 lands here: surface the API's sentence, keep the row (round 11).
			setError(e instanceof ApiError ? e.message : 'delete failed')
			setConfirming(false)
		}
	}

	return (
		<div className="flex max-w-xl flex-col gap-6">
			<Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
				← All clients
			</Button>
			<div className="rounded-xl border bg-card p-6 shadow-xs">
				<h1 className="font-serif text-2xl font-semibold tracking-display">{client.name}</h1>
				<dl className="mt-4 grid gap-3 text-sm">
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">Email</dt>
						<dd>{client.email}</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">Company</dt>
						<dd>{client.company || '—'}</dd>
					</div>
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">Added</dt>
						<dd>{new Date(client.createdAt).toLocaleDateString()}</dd>
					</div>
				</dl>
				{error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
				<div className="mt-6 flex gap-2">
					<Button variant="outline" onClick={onEdit}>
						Edit
					</Button>
					{confirming ? (
						<>
							<Button variant="destructive" onClick={doDelete}>
								Yes, delete
							</Button>
							<Button variant="ghost" onClick={() => setConfirming(false)}>
								Cancel
							</Button>
						</>
					) : (
						<Button variant="destructive" onClick={() => setConfirming(true)}>
							Delete
						</Button>
					)}
				</div>
			</div>
		</div>
	)
}

function ClientForm({ editing, onDone }: { editing?: Client; onDone: (saved?: Client) => void }) {
	const [name, setName] = useState(editing?.name ?? '')
	const [email, setEmail] = useState(editing?.email ?? '')
	const [company, setCompany] = useState(editing?.company ?? '')
	const [errors, setErrors] = useState<{ name?: string; email?: string; api?: string }>({})
	const [busy, setBusy] = useState(false)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		const next: typeof errors = {}
		if (!name.trim()) next.name = 'Name is required.'
		if (!email.trim()) next.email = 'Email is required.'
		setErrors(next)
		if (next.name || next.email) return
		setBusy(true)
		try {
			const body = { name: name.trim(), email: email.trim(), company: company.trim() || undefined }
			const saved = editing ? await api<Client>('PUT', `/api/clients/${editing.id}`, body) : await api<Client>('POST', '/api/clients', body)
			onDone(saved)
		} catch (err) {
			setErrors({ api: err instanceof ApiError ? err.message : 'save failed' })
		} finally {
			setBusy(false)
		}
	}

	return (
		<form onSubmit={submit} className="flex max-w-md flex-col gap-4">
			<h1 className="font-serif text-2xl font-semibold tracking-display">{editing ? 'Edit client' : 'New client'}</h1>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="c-name">Name</Label>
				<Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
				{errors.name ? <p className="text-sm text-destructive">{errors.name}</p> : null}
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="c-email">Email</Label>
				<Input id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
				{errors.email ? <p className="text-sm text-destructive">{errors.email}</p> : null}
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="c-company">Company (optional)</Label>
				<Input id="c-company" value={company} onChange={(e) => setCompany(e.target.value)} />
			</div>
			{errors.api ? <p className="text-sm text-destructive">{errors.api}</p> : null}
			<div className="flex gap-2">
				<Button type="submit" disabled={busy}>
					Save
				</Button>
				<Button type="button" variant="ghost" onClick={() => onDone()}>
					Cancel
				</Button>
			</div>
		</form>
	)
}
