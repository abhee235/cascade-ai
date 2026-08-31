// InvoicesView — the DataTable workhorse: status filter chips + pagination + CSV export (filter-aware),
// a line-items invoice form with live total, and a detail panel. Server owns totals; the UI only formats.

import { useCallback, useEffect, useState } from 'react'
import { Download, FilePlus2, FileText } from 'lucide-react'
import { DataTable, type DataColumn } from '@/components/blocks/DataTable'
import { EmptyState } from '@/components/blocks/EmptyState'
import { ErrorState } from '@/components/blocks/ErrorState'
import { SkeletonList } from '@/components/blocks/SkeletonList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError } from '@/lib/api'
import { fmtMoney } from '@/lib/money'
import type { Client, Invoice, InvoiceItem, InvoiceStatus, ListEnvelope } from '@/lib/types'

const PER_PAGE = 10
const STATUSES: (InvoiceStatus | 'all')[] = ['all', 'draft', 'sent', 'paid']
const badgeVariant = (s: InvoiceStatus) => (s === 'paid' ? 'default' : s === 'sent' ? 'secondary' : 'outline') as const

type Mode = { kind: 'list' } | { kind: 'detail'; invoice: Invoice } | { kind: 'form' }

export function InvoicesView() {
	const [mode, setMode] = useState<Mode>({ kind: 'list' })
	const [status, setStatus] = useState<InvoiceStatus | 'all'>('all')
	const [page, setPage] = useState(1)
	const [data, setData] = useState<ListEnvelope<Invoice> | null>(null)
	const [error, setError] = useState<string | null>(null)

	const query = `${status === 'all' ? '' : `status=${status}&`}page=${page}&perPage=${PER_PAGE}`
	const load = useCallback(() => {
		setError(null)
		setData(null)
		api<ListEnvelope<Invoice>>('GET', `/api/invoices?${query}`)
			.then(setData)
			.catch((e) => setError(e instanceof Error ? e.message : 'failed to load invoices'))
	}, [query])
	useEffect(load, [load])

	const pages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1

	if (mode.kind === 'form')
		return (
			<InvoiceForm
				onDone={() => {
					setMode({ kind: 'list' })
					load()
				}}
			/>
		)
	if (mode.kind === 'detail')
		return (
			<InvoiceDetail
				invoice={mode.invoice}
				onBack={() => setMode({ kind: 'list' })}
				onDeleted={() => {
					setMode({ kind: 'list' })
					load()
				}}
			/>
		)

	const columns: DataColumn<Invoice>[] = [
		{ key: 'client', header: 'Client', cell: (r) => r.clientName },
		{ key: 'status', header: 'Status', cell: (r) => <Badge variant={badgeVariant(r.status)}>{r.status}</Badge> },
		{ key: 'total', header: 'Total', numeric: true, cell: (r) => fmtMoney(r.total) },
		{ key: 'date', header: 'Date', cell: (r) => new Date(r.createdAt).toLocaleDateString() },
	]

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-serif text-2xl font-semibold tracking-display">Invoices</h1>
				<div className="flex gap-2">
					<Button variant="outline" asChild>
						<a href={`/api/invoices/export.csv${status === 'all' ? '' : `?status=${status}`}`} download>
							<Download className="size-4" /> Export CSV
						</a>
					</Button>
					<Button onClick={() => setMode({ kind: 'form' })}>
						<FilePlus2 className="size-4" /> New invoice
					</Button>
				</div>
			</div>
			<div className="flex flex-wrap gap-2">
				{STATUSES.map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => {
							setStatus(s)
							setPage(1)
						}}
						className={
							s === status
								? 'rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground'
								: 'rounded-full border px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground'
						}
					>
						{s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
					</button>
				))}
			</div>
			{error ? (
				<ErrorState
					title="Couldn't load invoices"
					description={error}
					action={
						<Button variant="outline" onClick={load}>
							Retry
						</Button>
					}
				/>
			) : !data ? (
				<SkeletonList shape="rows" count={6} />
			) : (
				<DataTable
					columns={columns}
					rows={data.items}
					rowKey={(r) => String(r.id)}
					onRowClick={(r) => setMode({ kind: 'detail', invoice: r })}
					empty={<EmptyState icon={FileText} title="No invoices yet" description="Bill your first project to see it here." action={<Button onClick={() => setMode({ kind: 'form' })}>New invoice</Button>} />}
					caption={
						<span className="flex items-center justify-between">
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
						</span>
					}
				/>
			)}
		</div>
	)
}

function InvoiceDetail({ invoice, onBack, onDeleted }: { invoice: Invoice; onBack: () => void; onDeleted: () => void }) {
	const [confirming, setConfirming] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const doDelete = async () => {
		try {
			await api('DELETE', `/api/invoices/${invoice.id}`)
			onDeleted()
		} catch (e) {
			setError(e instanceof ApiError ? e.message : 'delete failed')
			setConfirming(false)
		}
	}

	return (
		<div className="flex max-w-2xl flex-col gap-6">
			<Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
				← All invoices
			</Button>
			<div className="rounded-xl border bg-card p-6 shadow-xs">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h1 className="font-serif text-2xl font-semibold tracking-display">{invoice.clientName}</h1>
						<p className="mt-1 text-sm text-muted-foreground">{new Date(invoice.createdAt).toLocaleDateString()}</p>
					</div>
					<Badge variant={badgeVariant(invoice.status)}>{invoice.status}</Badge>
				</div>
				<table className="mt-6 w-full text-sm">
					<thead>
						<tr className="border-b text-left text-muted-foreground">
							<th className="pb-2 font-medium">Description</th>
							<th className="pb-2 text-right font-medium">Qty</th>
							<th className="pb-2 text-right font-medium">Unit</th>
							<th className="pb-2 text-right font-medium">Line</th>
						</tr>
					</thead>
					<tbody>
						{invoice.items.map((li, i) => (
							<tr key={li.id ?? i} className="border-b last:border-b-0">
								<td className="py-2">{li.description}</td>
								<td className="py-2 text-right tabular-nums">{li.qty}</td>
								<td className="py-2 text-right tabular-nums">{fmtMoney(li.unitPrice)}</td>
								<td className="py-2 text-right tabular-nums">{fmtMoney(li.qty * li.unitPrice)}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="mt-4 text-right font-medium">Total {fmtMoney(invoice.total)}</p>
				{error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
				<div className="mt-6 flex gap-2">
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

function InvoiceForm({ onDone }: { onDone: () => void }) {
	const [clients, setClients] = useState<Client[]>([])
	const [clientId, setClientId] = useState<number | ''>('')
	const [status, setStatus] = useState<InvoiceStatus>('draft')
	const [items, setItems] = useState<InvoiceItem[]>([{ description: '', qty: 1, unitPrice: 0 }])
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		api<ListEnvelope<Client>>('GET', '/api/clients?perPage=50')
			.then((d) => {
				setClients(d.items)
				if (d.items[0]) setClientId(d.items[0].id)
			})
			.catch(() => setError('could not load clients for the selector'))
	}, [])

	const setItem = (i: number, patch: Partial<InvoiceItem>) => setItems((all) => all.map((it, j) => (j === i ? { ...it, ...patch } : it)))
	const total = items.reduce((s, i) => s + (i.qty || 0) * (i.unitPrice || 0), 0)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await api('POST', '/api/invoices', { clientId, status, items })
			onDone()
		} catch (err) {
			// Server-side validation (empty lines, qty < 1, negative price) surfaces inline (round 11).
			setError(err instanceof ApiError ? err.message : 'save failed')
		} finally {
			setBusy(false)
		}
	}

	return (
		<form onSubmit={submit} className="flex max-w-2xl flex-col gap-5">
			<h1 className="font-serif text-2xl font-semibold tracking-display">New invoice</h1>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="inv-client">Client</Label>
					<select
						id="inv-client"
						value={clientId}
						onChange={(e) => setClientId(Number(e.target.value))}
						className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
					>
						{clients.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="inv-status">Status</Label>
					<select
						id="inv-status"
						value={status}
						onChange={(e) => setStatus(e.target.value as InvoiceStatus)}
						className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
					>
						<option value="draft">Draft</option>
						<option value="sent">Sent</option>
						<option value="paid">Paid</option>
					</select>
				</div>
			</div>
			<div className="flex flex-col gap-3">
				<Label>Line items</Label>
				{items.map((li, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while editing
					<div key={i} className="flex items-center gap-2">
						<Input placeholder="Description" value={li.description} onChange={(e) => setItem(i, { description: e.target.value })} className="flex-1" />
						<Input type="number" min={1} step={1} value={li.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} className="w-20" aria-label="Qty" />
						<Input type="number" min={0} step={0.01} value={li.unitPrice} onChange={(e) => setItem(i, { unitPrice: Number(e.target.value) })} className="w-28" aria-label="Unit price" />
						<Button type="button" variant="ghost" size="sm" disabled={items.length === 1} onClick={() => setItems((all) => all.filter((_, j) => j !== i))}>
							✕
						</Button>
					</div>
				))}
				<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setItems((all) => [...all, { description: '', qty: 1, unitPrice: 0 }])}>
					Add line
				</Button>
			</div>
			<p className="text-right text-sm text-muted-foreground">
				Total <span className="font-medium text-foreground">{fmtMoney(total)}</span>
			</p>
			{error ? <p className="text-sm text-destructive">{error}</p> : null}
			<div className="flex gap-2">
				<Button type="submit" disabled={busy || clientId === ''}>
					Save invoice
				</Button>
				<Button type="button" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
			</div>
		</form>
	)
}
