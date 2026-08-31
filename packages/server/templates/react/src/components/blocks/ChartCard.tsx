import type { ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { cn } from '@/lib/utils'

export interface ChartCardProps {
	title: ReactNode
	description?: ReactNode
	/** Row objects, e.g. [{ label: 'Mon', value: 12 }, …]. Keep it to ONE series per card. */
	data: Record<string, string | number>[]
	/** The key holding the x-axis label (default 'label'). */
	xKey?: string
	/** The key holding the value (default 'value'). */
	yKey?: string
	kind?: 'area' | 'bar' | 'line'
	/** Which chart token to paint with (1–5) — the preset supplies the actual colour. */
	tone?: 1 | 2 | 3 | 4 | 5
	/** Top-right slot: a range Select, a Badge, a legend. */
	action?: ReactNode
	/** Y axis is OFF by default: the tooltip carries the exact number, and the axis is noise in a KPI
	 *  card (shadcn's dashboard chart shows none). Turn it on for a chart read as a precise instrument. */
	showYAxis?: boolean
	height?: number
	className?: string
}

/** ONE CHART, token-coloured. Charts are the thing dashboards are FOR, so this wraps recharts with the
 *  design system already applied: preset chart colour, token grid/axis, no default recharts palette
 *  (which is off-theme in every preset and the fastest way to make a dashboard look generic). */
export function ChartCard({ title, description, data, xKey = 'label', yKey = 'value', kind = 'area', tone = 1, action, showYAxis = false, height = 260, className }: ChartCardProps) {
	// PRESET vars, not --color-* aliases: Tailwind v4 emits an alias only when a utility uses it, and
	// nothing uses `bg-chart-1`, so `var(--color-chart-1)` is undefined at runtime (measured: black charts).
	const color = `var(--chart-${tone})`
	const axis = { stroke: 'var(--muted-foreground)', fontSize: 12, tickLine: false, axisLine: false }
	const tooltip = (
		<Tooltip
			cursor={{ stroke: 'var(--border)' }}
			contentStyle={{
				background: 'var(--popover)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius)',
				color: 'var(--popover-foreground)',
				fontSize: 12,
			}}
		/>
	)
	return (
		<div data-block="chart-card" className={cn('flex flex-col gap-4 rounded-xl border bg-card p-6', className)}>
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<h3 className="font-medium">{title}</h3>
					{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
				</div>
				{action}
			</div>
			<div style={{ height }}>
				<ResponsiveContainer width="100%" height="100%">
					{kind === 'bar' ? (
						<BarChart data={data}>
							<CartesianGrid vertical={false} stroke="var(--border)" />
							<XAxis dataKey={xKey} {...axis} tickMargin={8} />
							{showYAxis ? <YAxis {...axis} width={40} /> : null}
							{tooltip}
							<Bar dataKey={yKey} fill={color} radius={[4, 4, 0, 0]} />
						</BarChart>
					) : kind === 'line' ? (
						<LineChart data={data}>
							<CartesianGrid vertical={false} stroke="var(--border)" />
							<XAxis dataKey={xKey} {...axis} tickMargin={8} />
							{showYAxis ? <YAxis {...axis} width={40} /> : null}
							{tooltip}
							<Line type="monotone" dataKey={yKey} stroke={color} strokeWidth={2} dot={false} />
						</LineChart>
					) : (
						<AreaChart data={data}>
							<defs>
								<linearGradient id={`fill-${tone}`} x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor={color} stopOpacity={0.35} />
									<stop offset="100%" stopColor={color} stopOpacity={0.02} />
								</linearGradient>
							</defs>
							<CartesianGrid vertical={false} stroke="var(--border)" />
							<XAxis dataKey={xKey} {...axis} tickMargin={8} />
							{showYAxis ? <YAxis {...axis} width={40} /> : null}
							{tooltip}
							<Area type="monotone" dataKey={yKey} stroke={color} strokeWidth={2} fill={`url(#fill-${tone})`} />
						</AreaChart>
					)}
				</ResponsiveContainer>
			</div>
		</div>
	)
}
