import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export interface DataColumn<T> {
	/** Stable key — also the sort key reported to onSortChange. */
	key: string
	header: ReactNode
	/** Cell renderer. Return a string/number for plain text, or any node (Badge, DropdownMenu…). */
	cell: (row: T) => ReactNode
	/** Right-align + tabular figures — use for every money/count column. */
	numeric?: boolean
	sortable?: boolean
	className?: string
}

export interface DataTableProps<T> {
	columns: DataColumn<T>[]
	rows: T[]
	rowKey: (row: T) => string
	/** Current sort, owned by the caller: { key, dir }. Sorting itself belongs in ONE useMemo upstream. */
	sort?: { key: string; dir: 'asc' | 'desc' }
	onSortChange?: (key: string) => void
	onRowClick?: (row: T) => void
	/** REQUIRED when rows can be empty — pass <EmptyState …/>. A blank table is a dead end. */
	empty?: ReactNode
	className?: string
}

/** THE dashboard/admin workhorse: a real table with sortable headers, right-aligned numerics, an empty
 *  state, and optional row actions in the last column. Generic over the row type, so the caller keeps its
 *  own data shape and this block never dictates a schema. */
export function DataTable<T>({ columns, rows, rowKey, sort, onSortChange, onRowClick, empty, className }: DataTableProps<T>) {
	if (rows.length === 0 && empty) return <div data-block="data-table">{empty}</div>
	return (
		<div data-block="data-table" className={cn('overflow-hidden rounded-xl border bg-card', className)}>
			<Table>
				<TableHeader>
					<TableRow>
						{columns.map((col) => {
							const active = sort?.key === col.key
							return (
								<TableHead key={col.key} className={cn(col.numeric && 'text-right', col.className)}>
									{col.sortable ? (
										<button
											type="button"
											onClick={() => onSortChange?.(col.key)}
											className={cn('inline-flex items-center gap-1 transition-colors hover:text-foreground', active ? 'text-foreground' : 'text-muted-foreground')}
										>
											{col.header}
											{active ? (sort.dir === 'asc' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />) : null}
										</button>
									) : (
										col.header
									)}
								</TableHead>
							)
						})}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={cn(onRowClick && 'cursor-pointer')}>
							{columns.map((col) => (
								<TableCell key={col.key} className={cn(col.numeric && 'text-right tabular-nums', col.className)}>
									{col.cell(row)}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
