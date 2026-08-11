import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface FilterBarProps {
	/** Search text, owned by the caller (one derived list upstream does search AND filter together). */
	query?: string
	onQueryChange?: (value: string) => void
	placeholder?: string
	/** Filter controls — <Select>s, a <Popover> of checkboxes, date pickers. */
	children?: ReactNode
	/** Active filters as removable chips, so what is filtering the list is always visible. */
	chips?: { label: ReactNode; onRemove?: () => void }[]
	/** Shown when anything is active — clears every filter at once. */
	onClear?: () => void
	/** Right-side slot: the primary action for the view ("New invoice"). */
	action?: ReactNode
	className?: string
}

/** SEARCH + FILTERS above a list or table. The rule this block encodes: the current filter state must be
 *  VISIBLE (chips) and reversible (clear) — a filtered list that looks like an empty list is the most
 *  common way a dashboard lies to its user. */
export function FilterBar({ query, onQueryChange, placeholder = 'Search…', children, chips = [], onClear, action, className }: FilterBarProps) {
	return (
		<div data-block="filter-bar" className={cn('flex flex-col gap-3', className)}>
			<div className="flex flex-wrap items-center gap-3">
				<div className="relative min-w-56 flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input value={query ?? ''} onChange={(e) => onQueryChange?.(e.target.value)} placeholder={placeholder} className="pl-9" />
				</div>
				{children}
				{action ? <div className="ml-auto">{action}</div> : null}
			</div>
			{chips.length > 0 ? (
				<div className="flex flex-wrap items-center gap-2">
					{chips.map((chip, i) => (
						<Badge key={i} variant="secondary" className="gap-1">
							{chip.label}
							{chip.onRemove ? (
								<button type="button" onClick={chip.onRemove} aria-label="Remove filter" className="transition-opacity hover:opacity-70">
									<X className="size-3" />
								</button>
							) : null}
						</Badge>
					))}
					{onClear ? (
						<Button variant="ghost" size="xs" onClick={onClear}>
							Clear all
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	)
}
