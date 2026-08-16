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

import { ArtImage as BaseArtImage } from '../src/components/blocks/ArtImage'
import { Footer as BaseFooter } from '../src/components/blocks/Footer'
import { Hero as BaseHero } from '../src/components/blocks/Hero'
import { MediaCard as BaseMediaCard } from '../src/components/blocks/MediaCard'
import { NavBar as BaseNavBar } from '../src/components/blocks/NavBar'
import { Section as BaseSection } from '../src/components/blocks/Section'
import { StatCard as BaseStatCard } from '../src/components/blocks/StatCard'
import { ArtImage as SharpArtImage } from './sharp/blocks/ArtImage'
import { Footer as SharpFooter } from './sharp/blocks/Footer'
import { Hero as SharpHero } from './sharp/blocks/Hero'
import { MediaCard as SharpMediaCard } from './sharp/blocks/MediaCard'
import { NavBar as SharpNavBar } from './sharp/blocks/NavBar'
import { Section as SharpSection } from './sharp/blocks/Section'
import { StatCard as SharpStatCard } from './sharp/blocks/StatCard'
import { ArtImage as SoftArtImage } from './soft/blocks/ArtImage'
import { Footer as SoftFooter } from './soft/blocks/Footer'
import { Hero as SoftHero } from './soft/blocks/Hero'
import { MediaCard as SoftMediaCard } from './soft/blocks/MediaCard'
import { NavBar as SoftNavBar } from './soft/blocks/NavBar'
import { Section as SoftSection } from './soft/blocks/Section'
import { StatCard as SoftStatCard } from './soft/blocks/StatCard'

export const parity = {
	sharp: [
		[SharpArtImage satisfies typeof BaseArtImage, BaseArtImage satisfies typeof SharpArtImage],
		[SharpFooter satisfies typeof BaseFooter, BaseFooter satisfies typeof SharpFooter],
		[SharpHero satisfies typeof BaseHero, BaseHero satisfies typeof SharpHero],
		[SharpMediaCard satisfies typeof BaseMediaCard, BaseMediaCard satisfies typeof SharpMediaCard],
		[SharpNavBar satisfies typeof BaseNavBar, BaseNavBar satisfies typeof SharpNavBar],
		[SharpSection satisfies typeof BaseSection, BaseSection satisfies typeof SharpSection],
		[SharpStatCard satisfies typeof BaseStatCard, BaseStatCard satisfies typeof SharpStatCard],
	],
	soft: [
		[SoftArtImage satisfies typeof BaseArtImage, BaseArtImage satisfies typeof SoftArtImage],
		[SoftFooter satisfies typeof BaseFooter, BaseFooter satisfies typeof SoftFooter],
		[SoftHero satisfies typeof BaseHero, BaseHero satisfies typeof SoftHero],
		[SoftMediaCard satisfies typeof BaseMediaCard, BaseMediaCard satisfies typeof SoftMediaCard],
		[SoftNavBar satisfies typeof BaseNavBar, BaseNavBar satisfies typeof SoftNavBar],
		[SoftSection satisfies typeof BaseSection, BaseSection satisfies typeof SoftSection],
		[SoftStatCard satisfies typeof BaseStatCard, BaseStatCard satisfies typeof SoftStatCard],
	],
}
