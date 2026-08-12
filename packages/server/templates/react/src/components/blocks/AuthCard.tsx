import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface AuthCardProps {
	brand?: ReactNode
	title: ReactNode
	subtitle?: ReactNode
	/** The form: Label+Input pairs, then ONE primary submit Button (see the forms skill). */
	children: ReactNode
	/** Under the card — "No account? Sign up", "Forgot password?". */
	footer?: ReactNode
	/** Shown above the fields when a submit fails — one sentence, no stack traces. */
	error?: ReactNode
	className?: string
}

/** SIGN IN / SIGN UP / RESET — one centred card on a quiet ground. Auth is the first screen a user sees,
 *  so it carries the brand; everything else on it is subtracted. Never put a nav bar or a footer here. */
export function AuthCard({ brand, title, subtitle, children, footer, error, className }: AuthCardProps) {
	return (
		<div data-block="auth-card" className={cn('flex min-h-screen items-center justify-center bg-muted/40 px-6 py-12', className)}>
			<div className="flex w-full max-w-sm flex-col gap-6">
				{brand ? <div className="flex items-center justify-center gap-2.5 font-serif text-lg font-semibold tracking-display">{brand}</div> : null}
				<div className="flex flex-col gap-5 rounded-xl border bg-card p-6 shadow-sm">
					<div className="flex flex-col gap-1.5 text-center">
						<h1 className="font-serif text-2xl font-semibold tracking-display">{title}</h1>
						{subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
					</div>
					{error ? (
						<p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{error}
						</p>
					) : null}
					<div className="flex flex-col gap-4">{children}</div>
				</div>
				{footer ? <p className="text-center text-sm text-muted-foreground">{footer}</p> : null}
			</div>
		</div>
	)
}
