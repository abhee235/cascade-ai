import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface ComposerProps {
	/** The signed-in user's avatar slot. */
	avatar?: ReactNode
	/** Controlled value — the draft lives in the CALLER's state, so it can clear it on submit. */
	value: string
	onValueChange: (value: string) => void
	/** Called on the submit button (and Cmd/Ctrl+Enter). The caller prepends the post and clears the draft. */
	onSubmit: () => void
	placeholder?: string
	/** Shows a live counter and disables submit past the limit (posting UIs cap; forms don't). */
	maxLength?: number
	/** The submit label — "Post", "Reply", "Send". */
	submitLabel?: ReactNode
	className?: string
}

/** WRITE A POST. Lives at the top of the feed (or under a post for replies). Submit disables on empty or
 *  over-limit — never a dead button with no reason; the counter IS the reason, turning destructive as it
 *  overflows. Cmd/Ctrl+Enter submits, because people who post a lot never reach for the mouse. */
export function Composer({ avatar, value, onValueChange, onSubmit, placeholder = 'What is happening?', maxLength, submitLabel = 'Post', className }: ComposerProps) {
	const over = maxLength !== undefined && value.length > maxLength
	const empty = value.trim().length === 0
	return (
		<div data-block="composer" className={cn('flex gap-3 px-4 py-4', className)}>
			{avatar ? <div className="size-10 shrink-0 [&_img]:size-full [&_img]:rounded-full [&_img]:object-cover">{avatar}</div> : null}
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<Textarea
					value={value}
					placeholder={placeholder}
					onChange={(e) => onValueChange(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !empty && !over) onSubmit()
					}}
					className="min-h-20 resize-none border-none bg-transparent p-0 text-[0.95rem] shadow-none focus-visible:ring-0"
				/>
				<div className="flex items-center justify-end gap-3 border-t pt-2.5">
					{maxLength !== undefined ? (
						<span className={cn('text-xs tabular-nums', over ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
							{value.length}/{maxLength}
						</span>
					) : null}
					<Button size="sm" disabled={empty || over} onClick={onSubmit}>
						{submitLabel}
					</Button>
				</div>
			</div>
		</div>
	)
}
