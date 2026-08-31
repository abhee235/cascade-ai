import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ProfileStat {
	value: string
	label: string
}

export interface ProfileHeaderProps {
	/** The cover band — a <Photo>, <ArtImage>, or <img>. Omit for a quiet tinted band. */
	cover?: ReactNode
	/** The avatar slot — overlaps the cover's bottom edge. */
	avatar: ReactNode
	name: ReactNode
	/** The quiet line under the name ("@lena · joined March 2024"). */
	handle?: ReactNode
	/** One or two sentences. Real bios are short; long ones read as fake. */
	bio?: ReactNode
	/** Posts / followers / following — 2–4 of these, values pre-formatted ("1,204"). */
	stats?: ProfileStat[]
	/** The one action: a Follow/Edit-profile Button, top right. */
	action?: ReactNode
	className?: string
}

/** THE PROFILE TOP: cover band, overlapping avatar, identity, stats. Everything under it is the user's
 *  own feed (stack FeedPost). The avatar OVERLAPS the cover — that one detail is what separates a
 *  profile page from a settings page with a picture. */
export function ProfileHeader({ cover, avatar, name, handle, bio, stats, action, className }: ProfileHeaderProps) {
	return (
		<div data-block="profile-header" className={cn('flex flex-col', className)}>
			<div className="h-36 overflow-hidden bg-accent sm:h-44 [&_img]:size-full [&_img]:object-cover [&_svg]:size-full">{cover}</div>
			<div className="px-4">
				<div className="flex items-end justify-between">
					{/* -mt pulls the avatar over the cover; the ring cuts it out of the photo behind it. */}
					<div className="-mt-10 size-20 overflow-hidden rounded-full ring-4 ring-background sm:-mt-12 sm:size-24 [&_img]:size-full [&_img]:object-cover [&_svg]:size-full">
						{avatar}
					</div>
					{action ? <div className="pb-2">{action}</div> : null}
				</div>
				<div className="mt-3 flex flex-col gap-1">
					<h1 className="font-serif text-xl font-semibold tracking-display">{name}</h1>
					{handle ? <span className="text-sm text-muted-foreground">{handle}</span> : null}
					{bio ? <p className="mt-1.5 max-w-md text-[0.95rem] leading-relaxed">{bio}</p> : null}
					{stats?.length ? (
						<div className="mt-2.5 flex gap-5 text-sm">
							{stats.map((s) => (
								<span key={s.label} className="text-muted-foreground">
									<span className="font-semibold tabular-nums text-foreground">{s.value}</span> {s.label}
								</span>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	)
}
