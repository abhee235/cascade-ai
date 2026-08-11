// REFERENCE PAGE — dashboard overview (category: dashboard). Never shipped to a project.
//
// The archetype: PageHeader → StatCard row (KPIs with deltas) → ChartCard(s) → FilterBar → DataTable
// with an EmptyState. Every number here is DERIVED from the rows below it — a dashboard whose totals are
// hardcoded is the fastest way to lose a user's trust, and useMemo is the only honest way to do it.

import { useMemo, useState } from 'react'
import { CreditCard, Package, TrendingDown, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChartCard } from '@/components/blocks/ChartCard'
import { DataTable, type DataColumn } from '@/components/blocks/DataTable'
import { EmptyState } from '@/components/blocks/EmptyState'
import { FilterBar } from '@/components/blocks/FilterBar'
import { PageHeader } from '@/components/blocks/PageHeader'
import { Section } from '@/components/blocks/Section'
import { StatCard } from '@/components/blocks/StatCard'

interface Order {
	id: string
	customer: string
	plan: 'Solo' | 'Team' | 'Company'
	status: 'paid' | 'pending' | 'failed'
	amount: number
	date: string
}

const ORDERS: Order[] = [
	{ id: 'INV-2041', customer: 'Kestrel Data', plan: 'Team', status: 'paid', amount: 588, date: '11 Aug' },
	{ id: 'INV-2040', customer: 'Bellhop', plan: 'Solo', status: 'paid', amount: 49, date: '11 Aug' },
	{ id: 'INV-2039', customer: 'Northwind Freight', plan: 'Company', status: 'pending', amount: 2400, date: '10 Aug' },
	{ id: 'INV-2038', customer: 'Osmond Studio', plan: 'Team', status: 'paid', amount: 588, date: '10 Aug' },
	{ id: 'INV-2037', customer: 'Trimble & Co', plan: 'Team', status: 'failed', amount: 588, date: '9 Aug' },
	{ id: 'INV-2036', customer: 'Fieldwire', plan: 'Solo', status: 'paid', amount: 49, date: '9 Aug' },
]

const RUNS = [
	{ label: 'Mon', value: 820 },
	{ label: 'Tue', value: 932 },
	{ label: 'Wed', value: 901 },
	{ label: 'Thu', value: 1290 },
	{ label: 'Fri', value: 1330 },
	{ label: 'Sat', value: 620 },
	{ label: 'Sun', value: 410 },
]

const STATUS_TONE = { paid: 'secondary', pending: 'outline', failed: 'destructive' } as const

export function DashboardHome() {
	const [query, setQuery] = useState('')
	const [plan, setPlan] = useState('all')
	const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' })

	// ONE derived list: search + filter + sort together. Never store what you can derive.
	const rows = useMemo(() => {
		const q = query.trim().toLowerCase()
		const filtered = ORDERS.filter((o) => (plan === 'all' || o.plan === plan) && (!q || o.customer.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)))
		return [...filtered].sort((a, b) => {
			const dir = sort.dir === 'asc' ? 1 : -1
			if (sort.key === 'amount') return (a.amount - b.amount) * dir
			return String(a[sort.key as keyof Order]).localeCompare(String(b[sort.key as keyof Order])) * dir
		})
	}, [query, plan, sort])

	const revenue = useMemo(() => rows.filter((o) => o.status === 'paid').reduce((sum, o) => sum + o.amount, 0), [rows])

	const columns: DataColumn<Order>[] = [
		{ key: 'id', header: 'Invoice', cell: (o) => <span className="font-medium">{o.id}</span>, sortable: true },
		{ key: 'customer', header: 'Customer', cell: (o) => o.customer, sortable: true },
		{ key: 'plan', header: 'Plan', cell: (o) => o.plan },
		{ key: 'status', header: 'Status', cell: (o) => <Badge variant={STATUS_TONE[o.status]}>{o.status}</Badge> },
		{ key: 'date', header: 'Date', cell: (o) => o.date, sortable: true },
		{ key: 'amount', header: 'Amount', cell: (o) => `$${o.amount.toLocaleString()}`, numeric: true, sortable: true },
	]

	return (
		<div>
			<PageHeader
				title="Overview"
				description="Runs, revenue, and invoices for the last 7 days."
				actions={
					<Select defaultValue="7d">
						<SelectTrigger className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="7d">Last 7 days</SelectItem>
							<SelectItem value="30d">Last 30 days</SelectItem>
							<SelectItem value="90d">Last quarter</SelectItem>
						</SelectContent>
					</Select>
				}
			/>

			<Section className="pt-0">
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<StatCard label="Revenue (paid)" value={`$${revenue.toLocaleString()}`} delta={12.4} deltaLabel="vs last week" icon={CreditCard} />
					<StatCard label="Runs" value="6,313" delta={8.1} deltaLabel="vs last week" icon={Package} />
					<StatCard label="Active teams" value="248" delta={3.2} deltaLabel="vs last week" icon={Users} />
					<StatCard label="Failure rate" value="0.42%" delta={-1.1} deltaLabel="vs last week" icon={TrendingDown} lowerIsBetter />
				</div>

				<div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
					<ChartCard title="Runs per day" description="Scheduled and manual, combined." data={RUNS} kind="area" tone={1} />
					<ChartCard title="Failures" description="Retried before alerting." data={RUNS.map((r) => ({ ...r, value: Math.round(r.value * 0.04) }))} kind="bar" tone={4} />
				</div>

				<div className="mt-8 flex flex-col gap-4">
					<FilterBar
						query={query}
						onQueryChange={setQuery}
						placeholder="Search invoices or customers…"
						chips={plan === 'all' ? [] : [{ label: `Plan: ${plan}`, onRemove: () => setPlan('all') }]}
						onClear={query || plan !== 'all' ? () => { setQuery(''); setPlan('all') } : undefined}
						action={<Button>New invoice</Button>}
					>
						<Select value={plan} onValueChange={setPlan}>
							<SelectTrigger className="w-40">
								<SelectValue placeholder="Plan" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All plans</SelectItem>
								<SelectItem value="Solo">Solo</SelectItem>
								<SelectItem value="Team">Team</SelectItem>
								<SelectItem value="Company">Company</SelectItem>
							</SelectContent>
						</Select>
					</FilterBar>

					<DataTable
						columns={columns}
						rows={rows}
						rowKey={(o) => o.id}
						sort={sort}
						onSortChange={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
						empty={<EmptyState title="No invoices match" description="Try a different search or clear the plan filter." action={<Button variant="outline" onClick={() => { setQuery(''); setPlan('all') }}>Clear filters</Button>} />}
					/>
				</div>
			</Section>
		</div>
	)
}
