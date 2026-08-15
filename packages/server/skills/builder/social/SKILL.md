---
name: social
description: Feed apps end to end — the reading column, posts with derived counts, a composer that clears on submit, post detail with replies, and the profile page. The block set, the one-array state shape, and the numbers a feed must hit.
whenToUse: Load BEFORE building any social network, feed, timeline, microblog, forum, comments app, community, "like Twitter/X/Mastodon/Threads", posts-and-replies, or activity-stream app. Also when the user says the feed or composer is broken.
---
# Social — a feed is ONE array and three views

The failure mode is never the post card — it is the STATE: separate arrays for feed/replies/profile that
drift apart, like counts stored per-view, a composer that posts into nowhere. Build ONE posts array;
derive everything else from it.

## The contract — a feed app is DONE when all three views exist and connect

| View | Must contain | Reachable from |
|---|---|---|
| **feed** | `<Composer>` on top, then `<FeedPost>` per post in a `divide-y` column | the landing view |
| **post detail** | the post (unclickable), a Replies section (`<EmptyState>` when none), back to feed | clicking a post |
| **profile** | `<ProfileHeader>` (cover, overlapping avatar, stats), then that user's posts | clicking an author name |

Clicking the AUTHOR opens the profile; clicking the POST opens the detail — two different targets on one
surface, so the name button must `stopPropagation()`.

## State — ONE array, everything else derived

```tsx
interface Post { id: string; author: string; handle: string; time: string; body: string; image?: string; likes: number; replyTo?: string }

const [posts, setPosts] = useState<Post[]>(SEED)      // the ONE source of truth (replies live here too)
const [liked, setLiked] = useState<Set<string>>(new Set())

const feed = useMemo(() => posts.filter(p => !p.replyTo), [posts])
const repliesTo = (id: string) => posts.filter(p => p.replyTo === id)
const postsBy = (handle: string) => posts.filter(p => p.handle === handle && !p.replyTo)
// A like renders as posts.likes + (liked.has(id) ? 1 : 0) — the count is DERIVED, the toggle is yours.
```

Submitting the composer PREPENDS and clears: `setPosts(p => [newPost, ...p]); setDraft('')`. A composer
whose text survives its own submit reads as broken even when the post landed.

## The layout — a single reading column

```tsx
<NavBar brand="Murmur" />
<main className="mx-auto max-w-xl">
  <div className="divide-y">
    <Composer avatar={…} value={draft} onValueChange={setDraft} onSubmit={submit} maxLength={280} />
    {feed.map(p => <FeedPost key={p.id} … />)}
  </div>
</main>
```

`max-w-xl`, `divide-y`, no cards, no grid — a feed is a COLUMN. The full working page (all three views,
the like/reply derivations, the profile wiring): `Skill {name: "social", file: "reference/pages.md"}` —
verbatim source of a page that renders; copy its SHAPE, never its copy or data.

## Imagery and identity

- Avatars are `<Avatar><AvatarFallback>{initials}</AvatarFallback></Avatar>` — initials, NEVER photos of
  strangers and never emoji. Post media is `<Photo web="…" seed={post.id}>` and lives ON the post data.
- Seed ≥5 posts by ≥4 different authors, at least one with media and at least one reply — an empty social
  app cannot demonstrate any of its own mechanics.

## Acceptance — check each before you call it done

- [ ] Posting from the composer prepends to the feed AND clears the draft; empty/over-limit submit is disabled.
- [ ] The like toggle moves the count up AND back down; state survives switching views.
- [ ] Clicking a post opens detail with its replies; clicking an author (anywhere) opens their profile.
- [ ] The profile shows the cover, the OVERLAPPING avatar, stats, and only that user's posts.
- [ ] No reply appears in the main feed; every reply appears under its parent.
- [ ] `npm run build` green → `TemplateAudit {}` clean → `Browser {op:"open"}` → `Browser {op:"audit"}` clean.

## Out of scope unless asked

Accounts (load the `auth` skill), real-time updates, notifications, DMs, infinite scroll. Persistence is
the browser via `src/lib/storage.ts`; a server needs the `backend` skill and `ApplyPack`.
