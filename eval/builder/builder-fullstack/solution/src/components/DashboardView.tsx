// DashboardView — 4 KPIs + the revenue chart, all from /api/stats (round 8). Loading = skeleton stats row;
// failure = ErrorState with Retry (every data view carries the full loading/empty/error set — round 12).

import { useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { FileText, PiggyBank, Timer, Users } from 'lucide-react'
import { ChartCard } from '@/components/blocks/ChartCard'
import { ErrorState } from '@/components/blocks/ErrorState'
import { SkeletonList } from '@/components/blocks/SkeletonList'
import { StatCard } from '@/components/blocks/StatCard'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { fmtMoney } from '@/lib/money'
import type { Stats } from '@/lib/types'

export function DashboardView(_props: { icon?: ComponentType<{ className?: string }> }) {
	const [stats, setStats] = useState<Stats | null>(null)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(() => {
		setError(null)
		setStats(null)
		api<Stats>('GET', '/api/stats')
			.then(setStats)
			.catch((e) => setError(e instanceof Error ? e.message : 'failed to load stats'))
	}, [])
	useEffect(load, [load])

	if (error)
		return (
			<ErrorState
				title="Couldn't load the dashboard"
				description={error}
				action={
					<Button variant="outline" onClick={load}>
						Retry
					</Button>
				}
			/>
		)
	if (!stats) return <SkeletonList shape="stats" count={4} />

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h1 className="font-serif text-2xl font-semibold tracking-display">Welcome back</h1>
				<p className="mt-1 text-sm text-muted-foreground">The studio at a glance — money out, money in, and who it belongs to.</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard label="Clients" value={String(stats.clients)} icon={Users} note="active in the book" />
				<StatCard label="Invoices" value={String(stats.invoices)} icon={FileText} note="all statuses" />
				<StatCard label="Outstanding" value={fmtMoney(stats.outstandingTotal)} icon={Timer} note="sent, awaiting payment" />
				<StatCard label="Revenue" value={fmtMoney(stats.paidTotal)} icon={PiggyBank} note="paid to date" />
			</div>
			<ChartCard
				title="Revenue by month"
				description="Sent and paid invoices, last six months."
				kind="bar"
				data={stats.revenueByMonth.map((m) => ({ label: m.month, value: m.total }))}
			/>
		</div>
	)
}
