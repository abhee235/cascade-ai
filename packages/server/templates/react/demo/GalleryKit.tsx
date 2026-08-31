// Starter showcase (delete src/demo/ when building the real app). The kit sheet: every ui/ component
// and imagery helper in one place — a living spec of the design system.

import { Inbox, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArtImage } from '@/components/blocks/ArtImage'
import { EmptyState } from '@/components/blocks/EmptyState'
import { PageHeader } from '@/components/blocks/PageHeader'
import { Section } from '@/components/blocks/Section'
import { photo } from '@/lib/photos'

const ART_SEEDS = ['Atlas Daypack', 'Harbor Ceramic Set', 'Ridge Enamel Mug', 'Coastline Throw', 'Meridian Journal', 'Summit Bottle']
const PHOTO_NAMES = ['food-bowl', 'product-shoe', 'workspace-code', 'nature-mountain', 'interior-living', 'people-friends'] as const

export function GalleryKit() {
	return (
		<div>
			<PageHeader
				title="The kit"
				description="Every control, token, and imagery helper — the living spec of this design system."
				actions={
					<>
						<Input placeholder="Search…" className="w-44" />
						<Button>Primary action</Button>
					</>
				}
			/>

			<Section heading="Controls">
				<div className="grid gap-6 md:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>Buttons & badges</CardTitle>
							<CardDescription>One primary CTA per screenful; the rest stay quiet.</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-wrap items-center gap-3">
							<Button>Primary</Button>
							<Button variant="secondary">Secondary</Button>
							<Button variant="outline">Outline</Button>
							<Button variant="ghost">Ghost</Button>
							<Button variant="destructive">Delete</Button>
							<Badge>Badge</Badge>
							<Badge variant="secondary">Secondary</Badge>
							<Badge variant="outline">Outline</Badge>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Form controls</CardTitle>
							<CardDescription>Inputs, selects, toggles — all token-styled.</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							<div className="flex items-center gap-2">
								<Search className="size-4 text-muted-foreground" />
								<Input placeholder="Search products…" />
							</div>
							<Select>
								<SelectTrigger>
									<SelectValue placeholder="Sort by" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="featured">Featured</SelectItem>
									<SelectItem value="price">Price</SelectItem>
								</SelectContent>
							</Select>
							<div className="flex items-center gap-6">
								<span className="flex items-center gap-2 text-sm">
									<Checkbox id="c1" defaultChecked /> <Label htmlFor="c1">In stock</Label>
								</span>
								<span className="flex items-center gap-2 text-sm">
									<Switch id="s1" defaultChecked /> <Label htmlFor="s1">Dark mode</Label>
								</span>
							</div>
						</CardContent>
					</Card>
				</div>
			</Section>

			<Section tone="muted" heading="Imagery" description="ArtImage: deterministic, token-aware SVG art (top) — photo pack (bottom). Never an emoji, never a gray box.">
				<div className="grid grid-cols-3 gap-4 lg:grid-cols-6">
					{ART_SEEDS.map((s) => (
						<div key={s} className="aspect-square overflow-hidden rounded-lg">
							<ArtImage seed={s} kind="product" />
						</div>
					))}
					{PHOTO_NAMES.map((n) => (
						<div key={n} className="aspect-square overflow-hidden rounded-lg">
							<img src={photo(n)} alt={n} className="size-full object-cover" />
						</div>
					))}
				</div>
			</Section>

			<Section heading="States">
				<Tabs defaultValue="empty">
					<TabsList>
						<TabsTrigger value="empty">Empty state</TabsTrigger>
						<TabsTrigger value="type">Type scale</TabsTrigger>
					</TabsList>
					<TabsContent value="empty" className="pt-4">
						<EmptyState icon={Inbox} title="No orders yet" description="When customers check out, their orders appear here." action={<Button variant="outline">Browse the catalog</Button>} />
					</TabsContent>
					<TabsContent value="type" className="flex flex-col gap-2 pt-4">
						<p className="font-serif text-4xl font-semibold tracking-tight">Display serif — Fraunces</p>
						<p className="text-2xl font-semibold tracking-tight">Title — Inter semibold</p>
						<p className="text-base">Body — Inter regular, comfortable measure.</p>
						<p className="text-sm text-muted-foreground">Muted small — metadata, captions, helper text.</p>
					</TabsContent>
				</Tabs>
			</Section>
		</div>
	)
}
