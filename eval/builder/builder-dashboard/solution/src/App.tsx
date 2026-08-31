// SOLUTION EXEMPLAR — the shape builder-dashboard is measured against. Every number below is DERIVED
// from RUNS in a useMemo, so changing the search moves the KPIs; a typed-in number would look identical
// on screen and be a lie the moment a filter moves.

import { useMemo, useState } from 'react'
import { BarChart3, Coins, LayoutDashboard, PackageCheck, Route, Truck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { AppShell } from '@/components/blocks/AppShell'
import { ChartCard } from '@/components/blocks/ChartCard'
import { DataTable, type DataColumn } from '@/components/blocks/DataTable'
import { EmptyState } from '@/components/blocks/EmptyState'
import { FilterBar } from '@/components/blocks/FilterBar'
import { StatCard } from '@/components/blocks/StatCard'
import { RUNS, type Run } from '@/lib/data'

const money = (n: number) => `$${n.toLocaleString('en-US')}`

export default function App() {
	const [query, setQuery] = useState('')
	const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' })

	// ONE derivation does search AND sort — never two lists kept in sync.
	const rows = useMemo(() => {
		const q = query.trim().toLowerCase()
		const filtered = q ? RUNS.filter((r) => `${r.route} ${r.driver} ${r.status}`.toLowerCase().includes(q)) : RUNS
		return [...filtered].sort((a, b) => {
			const dir = sort.dir === 'asc' ? 1 : -1
			if (sort.key === 'cost') return (a.cost - b.cost) * dir
			return a[sort.key as 'date' | 'route'].localeCompare(b[sort.key as 'date' | 'route']) * dir
		})
	}, [query, sort])

	// KPIs read the SAME rows the table shows, so they move when the search does.
	const totalRuns = useMemo(() => rows.length, [rows])
	const onTimeRate = useMemo(() => (rows.length === 0 ? 0 : Math.round((rows.filter((r) => r.status === 'delivered').length / rows.length) * 100)), [rows])
	const totalCost = useMemo(() => rows.reduce((sum, r) => sum + r.cost, 0), [rows])

	const perDay = useMemo(() => {
		const byDay = new Map<string, number>()
		for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + 1)
		return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ label: date.slice(5), value }))
	}, [rows])

	const columns: DataColumn<Run>[] = [
		{ key: 'route', header: 'Route', cell: (r) => r.route, sortable: true },
		{ key: 'driver', header: 'Driver', cell: (r) => r.driver },
		{
			key: 'status',
			header: 'Status',
			cell: (r) => <Badge variant={r.status === 'delivered' ? 'secondary' : r.status === 'delayed' ? 'outline' : 'destructive'}>{r.status}</Badge>,
		},
		{ key: 'date', header: 'Date', cell: (r) => r.date, sortable: true },
		{ key: 'cost', header: 'Cost', cell: (r) => money(r.cost), numeric: true, sortable: true },
	]

	return (
		<AppShell
			brand={
				<>
					<Truck className="size-4 text-primary" /> Northwind Ops
				</>
			}
			groups={[
				{ items: [{ label: 'Overview', icon: LayoutDashboard, active: true }, { label: 'Runs', icon: Route }, { label: 'Reports', icon: BarChart3 }] },
			]}
			header={<span className="font-medium">Overview</span>}
		>
			<div className="flex flex-col gap-6">
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					<StatCard label="Runs" value={totalRuns.toLocaleString('en-US')} delta={8.2} trendLabel="More routes covered" note="vs last week" icon={Route} />
					<StatCard label="On-time rate" value={`${onTimeRate}%`} delta={2.4} trendLabel="Fewer delays" note="Delivered ÷ all runs" icon={PackageCheck} />
					<StatCard label="Total cost" value={money(totalCost)} delta={-4.1} trendLabel="Cheaper per run" note="vs last week" icon={Coins} lowerIsBetter />
				</div>

				<ChartCard title="Runs per day" description="Every run in the current filter." data={perDay} kind="area" tone={1} />

				<FilterBar query={query} onQueryChange={setQuery} placeholder="Search route, driver or status…" onClear={query ? () => setQuery('') : undefined} />

				<DataTable
					columns={columns}
					rows={rows}
					rowKey={(r) => r.id}
					sort={sort}
					onSortChange={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
					caption={`${rows.length} of ${RUNS.length} runs`}
					empty={<EmptyState title="No runs match" description="No delivery run matches that search." />}
				/>
			</div>
		</AppShell>
	)
}
