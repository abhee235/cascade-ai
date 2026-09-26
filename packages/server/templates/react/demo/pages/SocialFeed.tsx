// REFERENCE PAGE — the social/feed set (category: social). Never shipped to a project.
//
// The three views a social app actually needs — feed, post detail (with replies), profile — in one file
// so the state flow reads end to end. The posts array is the ONE piece of stored state; like counts,
// reply threads and the profile's own-posts list are all derived from it. A feed is a single reading
// COLUMN (max-w-xl, divide-y), never a card grid: the divider rhythm is what makes it scannable.

import { useMemo, useState } from 'react'
import { ArrowLeft, Heart, MessageCircle, Repeat2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Composer } from '@/components/blocks/Composer'
import { EmptyState } from '@/components/blocks/EmptyState'
import { FeedPost } from '@/components/blocks/FeedPost'
import { NavBar } from '@/components/blocks/NavBar'
import { Photo } from '@/components/blocks/Photo'
import { ProfileHeader } from '@/components/blocks/ProfileHeader'
import { ArtImage } from '@/components/blocks/ArtImage'

interface Post {
	id: string
	author: string
	handle: string
	time: string
	body: string
	/** Imagery is DATA on the entity (data skill): keywords for <Photo web>, or undefined for text-only. */
	image?: string
	likes: number
	replyTo?: string
}

const ME = { name: 'Lena Fischer', handle: '@lena' }

const SEED: Post[] = [
	{ id: 't1', author: 'Priya Raman', handle: '@priya', time: '2h', body: 'Shipped the incident-grouping rewrite. Ten thousand errors, nine real incidents — the demo sells itself now.', likes: 24 },
	{ id: 't2', author: 'Sam Okafor', handle: '@sam', time: '3h', body: 'Morning ridge run before standup. The fog burned off exactly at the summit line.', image: 'mountain ridge sunrise fog', likes: 51 },
	{ id: 't3', author: 'Lena Fischer', handle: '@lena', time: '5h', body: 'Hot take: most dashboards would be better as a single sentence delivered at the right moment.', likes: 87 },
	{ id: 't4', author: 'Marco Salas', handle: '@marco', time: '6h', body: 'Replying with the counter-take: the sentence still needs the dashboard behind it, or nobody trusts it.', likes: 12, replyTo: 't3' },
	{ id: 't5', author: 'Aisha Bello', handle: '@aisha', time: '8h', body: 'New ceramics batch out of the kiln. The cobalt glaze finally behaved.', image: 'ceramic pottery cobalt glaze', likes: 33 },
]

type View = 'feed' | { kind: 'post'; id: string } | { kind: 'profile'; handle: string }

const initials = (name: string) => name.split(' ').map((p) => p[0]).join('')

export function SocialFeed() {
	const [posts, setPosts] = useState<Post[]>(SEED)
	const [liked, setLiked] = useState<Set<string>>(new Set(['t3']))
	const [draft, setDraft] = useState('')
	const [view, setView] = useState<View>('feed')

	// Derived, never stored: the visible feed (no replies), a post's replies, a profile's own posts.
	const feed = useMemo(() => posts.filter((p) => !p.replyTo), [posts])
	const repliesTo = (id: string) => posts.filter((p) => p.replyTo === id)
	const postsBy = (handle: string) => posts.filter((p) => p.handle === handle && !p.replyTo)

	const toggleLike = (id: string) =>
		setLiked((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	const submit = () => {
		setPosts((p) => [{ id: `t${Date.now()}`, author: ME.name, handle: ME.handle, time: 'now', body: draft.trim(), likes: 0 }, ...p])
		setDraft('')
	}

	const renderPost = (p: Post, clickable = true) => (
		<FeedPost
			key={p.id}
			avatar={
				<Avatar className="size-10">
					<AvatarFallback>{initials(p.author)}</AvatarFallback>
				</Avatar>
			}
			author={
				<button
					type="button"
					className="hover:underline"
					onClick={(e) => {
						e.stopPropagation() // the name opens the PROFILE; the post opens the DETAIL
						setView({ kind: 'profile', handle: p.handle })
					}}
				>
					{p.author}
				</button>
			}
			meta={`${p.handle} · ${p.time}`}
			media={p.image ? <Photo web={p.image} seed={p.id} kind="banner" /> : undefined}
			onClick={clickable ? () => setView({ kind: 'post', id: p.id }) : undefined}
			actions={
				<>
					<Button
						variant="ghost"
						size="sm"
						className={liked.has(p.id) ? 'text-destructive' : undefined}
						onClick={(e) => {
							e.stopPropagation()
							toggleLike(p.id)
						}}
					>
						<Heart className={liked.has(p.id) ? 'size-4 fill-current' : 'size-4'} />
						<span className="tabular-nums">{p.likes + (liked.has(p.id) ? 1 : 0)}</span>
					</Button>
					<Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
						<MessageCircle className="size-4" />
						<span className="tabular-nums">{repliesTo(p.id).length}</span>
					</Button>
					<Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
						<Repeat2 className="size-4" />
					</Button>
				</>
			}
		>
			{p.body}
		</FeedPost>
	)

	const detail = typeof view === 'object' && view.kind === 'post' ? posts.find((p) => p.id === view.id) : undefined
	const profile = typeof view === 'object' && view.kind === 'profile' ? view.handle : undefined
	const profilePost = profile ? posts.find((p) => p.handle === profile) : undefined

	return (
		<div>
			<NavBar
				brand="Murmur"
				actions={
					<Button variant="outline" size="sm" onClick={() => setView({ kind: 'profile', handle: ME.handle })}>
						My profile
					</Button>
				}
			/>
			{/* ONE reading column. Everything renders inside it — that IS the social layout. */}
			<main className="mx-auto max-w-xl">
				{view === 'feed' ? (
					<div className="divide-y">
						<Composer
							avatar={
								<Avatar className="size-10">
									<AvatarFallback>{initials(ME.name)}</AvatarFallback>
								</Avatar>
							}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							maxLength={280}
						/>
						{feed.map((p) => renderPost(p))}
					</div>
				) : detail ? (
					<div className="flex flex-col">
						<Button variant="ghost" size="sm" className="m-2 self-start" onClick={() => setView('feed')}>
							<ArrowLeft className="size-4" /> Back
						</Button>
						{renderPost(detail, false)}
						<h2 className="border-y bg-muted/40 px-4 py-2 text-sm font-medium text-muted-foreground">Replies</h2>
						{repliesTo(detail.id).length === 0 ? (
							<EmptyState title="No replies yet" description="Be the first to answer." className="m-4" />
						) : (
							<div className="divide-y">{repliesTo(detail.id).map((r) => renderPost(r, false))}</div>
						)}
					</div>
				) : profile && profilePost ? (
					<div className="flex flex-col">
						<Button variant="ghost" size="sm" className="m-2 self-start" onClick={() => setView('feed')}>
							<ArrowLeft className="size-4" /> Back to feed
						</Button>
						<ProfileHeader
							cover={<ArtImage seed={profile} kind="banner" />}
							avatar={
								<Avatar className="size-full">
									<AvatarFallback className="text-2xl">{initials(profilePost.author)}</AvatarFallback>
								</Avatar>
							}
							name={profilePost.author}
							handle={`${profile} · joined March 2024`}
							bio="Builds things, breaks things, posts about both."
							stats={[
								{ value: String(postsBy(profile).length), label: 'posts' },
								{ value: '1,204', label: 'followers' },
								{ value: '312', label: 'following' },
							]}
							action={<Button size="sm">Follow</Button>}
						/>
						<h2 className="mt-4 border-y bg-muted/40 px-4 py-2 text-sm font-medium text-muted-foreground">Posts</h2>
						<div className="divide-y">{postsBy(profile).map((p) => renderPost(p))}</div>
					</div>
				) : null}
			</main>
		</div>
	)
}
