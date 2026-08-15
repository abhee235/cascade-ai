// THE INTEROP INVARIANT (design-overhaul P5). Every skin ships alternate IMPLEMENTATIONS of base blocks;
// what makes the swap safe is that the interfaces are identical — an app written against base MediaCard
// must render unchanged under sharp MediaCard, and back. This file makes that a COMPILE ERROR instead of
// a runtime surprise: each pair is asserted assignable in BOTH directions (A satisfies typeof B alone
// would let A accept extra optional props that B then silently drops).
//
// Never shipped to projects (skins/ is excluded by templateCopyFilter) and never bundled (vite starts
// from index.html); it exists so `tsc -b` — which runs on every template build, eval verify, and dev
// session — refuses to compile a skin whose props drifted. Adding a block to a skin? Add its pair here;
// the skins test (packages/server/test) fails if you forget.
//
// KNOWN LIMIT, proven by drifting on purpose (2026-08-16): this catches a narrowed type, a changed type,
// and a missing/required prop — but NOT an extra OPTIONAL prop, because width subtyping makes it invisible
// to structural assignability in both directions. The skins test closes that gap textually: it compares
// the exact prop-NAME sets of each interface pair, so a skin quietly growing `tagline?` still fails.

import { Hero as BaseHero } from '../src/components/blocks/Hero'
import { MediaCard as BaseMediaCard } from '../src/components/blocks/MediaCard'
import { NavBar as BaseNavBar } from '../src/components/blocks/NavBar'
import { StatCard as BaseStatCard } from '../src/components/blocks/StatCard'
import { Hero as SharpHero } from './sharp/blocks/Hero'
import { MediaCard as SharpMediaCard } from './sharp/blocks/MediaCard'
import { NavBar as SharpNavBar } from './sharp/blocks/NavBar'
import { StatCard as SharpStatCard } from './sharp/blocks/StatCard'

export const parity = {
	sharp: [
		[SharpHero satisfies typeof BaseHero, BaseHero satisfies typeof SharpHero],
		[SharpMediaCard satisfies typeof BaseMediaCard, BaseMediaCard satisfies typeof SharpMediaCard],
		[SharpNavBar satisfies typeof BaseNavBar, BaseNavBar satisfies typeof SharpNavBar],
		[SharpStatCard satisfies typeof BaseStatCard, BaseStatCard satisfies typeof SharpStatCard],
	],
}
