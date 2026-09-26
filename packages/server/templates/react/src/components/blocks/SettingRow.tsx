import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SettingRowProps {
	/** The setting's name — short, sentence case ("Email notifications", not "EMAIL_NOTIFS"). */
	label: ReactNode
	/** What it does, in one line. Settings without descriptions get toggled by accident. */
	description?: ReactNode
	/** The control: a Switch, Select, Button, or Input. ONE control per row. */
	control?: ReactNode
	/** Full-width content under the row — a nested form, a danger-zone explanation. */
	children?: ReactNode
	className?: string
}

/** ONE SETTING. Stack these inside a `divide-y rounded-xl border bg-card` container: label + description
 *  on the left, control hard right, a divider between rows. This is the shape every settings, account,
 *  and notification-preferences page takes — and the shape models most often get wrong by stacking the
 *  control UNDER the label, which turns a scannable list into a long ragged form.
 *
 *  On narrow screens the control drops below the text (sm: puts it back on the right) rather than
 *  squeezing both into one line. */
export function SettingRow({ label, description, control, children, className }: SettingRowProps) {
	return (
		<div data-block="setting-row" className={cn('flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm font-medium">{label}</span>
				{description ? <span className="text-sm text-muted-foreground">{description}</span> : null}
				{children}
			</div>
			{control ? <div className="shrink-0">{control}</div> : null}
		</div>
	)
}
