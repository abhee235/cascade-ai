// SOLUTION EXEMPLAR — the shape builder-landing is measured against. A landing page is a SEQUENCE OF
// BANDS, each one a block with props; there is no bespoke CSS on this page. The measured failure it
// guards against is a page that renders a beautiful hero and then stops.

import { Layers, ShieldCheck, Sparkles, Waypoints } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BentoGrid } from '@/components/blocks/BentoGrid'
import { CTASection } from '@/components/blocks/CTASection'
import { FAQ } from '@/components/blocks/FAQ'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { LogoStrip } from '@/components/blocks/LogoStrip'
import { NavBar } from '@/components/blocks/NavBar'
import { PricingTable } from '@/components/blocks/PricingTable'
import { Section } from '@/components/blocks/Section'
import { Testimonial } from '@/components/blocks/Testimonial'
import { photo } from '@/lib/photos'

export default function App() {
	return (
		<div>
			<NavBar
				brand={
					<>
						<Layers className="size-4 text-primary" /> Ferrite
					</>
				}
				links={
					<>
						<a href="#features" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
							Features
						</a>
						<a href="#pricing" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
							Pricing
						</a>
						<a href="#faq" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
							FAQ
						</a>
					</>
				}
				actions={<Button>Start free</Button>}
			/>

			{/* Two-tone headline: the second clause muted — the current idiom (landing skill). */}
			<Hero
				layout="collage"
				badge={
					<Badge variant="secondary" className="gap-1.5">
						<Sparkles className="size-3" /> Now grouping by stack trace
					</Badge>
				}
				headline={
					<>
						Ten thousand errors, <span className="text-muted-foreground">nine real incidents.</span>
					</>
				}
				subcopy="Ferrite reads your logs, collapses the duplicates, and ranks what is left by how many customers it actually touched."
				actions={
					<>
						<Button size="lg">Start free</Button>
						<Button size="lg" variant="outline">
							See a live demo
						</Button>
					</>
				}
				media={<img src={photo('workspace-code')} alt="The Ferrite incident list" />}
			/>

			<Section>
				<LogoStrip label="Watching production at" items={['Northwind', 'Kestrel', 'Bellhop', 'Trimble', 'Osmond', 'Fieldwire']} />
			</Section>

			<Section id="features" tone="muted" eyebrow="Why teams switch" heading="Signal, not a firehose" description="Every alert names the change that caused it and the person who shipped it.">
				<BentoGrid
					tiles={[
						{
							kind: 'media',
							span: 2,
							title: 'One incident, not four hundred alerts',
							description: 'Ferrite groups by stack trace and release, so a single bad deploy reads as one line.',
							media: <img src={photo('workspace-office')} alt="Grouped incidents" />,
						},
						{ kind: 'stat', value: '94%', label: 'Fewer pages in the first month' },
						{ kind: 'plain', icon: Waypoints, title: 'Blames the diff', description: 'Each incident links the commit and the release that introduced it.' },
						{ kind: 'plain', icon: ShieldCheck, title: 'Your data stays yours', description: 'Self-host the collector; we never see raw log bodies.' },
						{ kind: 'accent', title: 'Import from anywhere', description: 'Sentry, CloudWatch, or a plain JSON endpoint.', action: <Button variant="secondary">See integrations</Button> },
					]}
				/>
			</Section>

			<Section id="pricing" eyebrow="Pricing" heading="Priced per service, not per seat" description="Invite the whole team — you are billed for what you actually monitor.">
				<PricingTable
					tiers={[
						{
							name: 'Solo',
							price: '$0',
							period: 'mo',
							description: 'One service and a side project.',
							features: ['1 service', '7-day retention', 'Community support'],
							action: <Button variant="outline">Start free</Button>,
						},
						{
							name: 'Team',
							price: '$79',
							period: 'mo',
							description: 'For a team that gets paged.',
							features: ['Unlimited services', '90-day retention', 'On-call routing', 'Release tracking'],
							action: <Button>Start 14-day trial</Button>,
							highlighted: true,
						},
						{
							name: 'Company',
							price: 'Custom',
							description: 'SSO, residency, and a contract.',
							features: ['Everything in Team', 'SAML SSO + SCIM', 'Data residency', 'Named engineer'],
							action: <Button variant="outline">Talk to us</Button>,
						},
					]}
				/>
			</Section>

			<Section tone="wash">
				<Testimonial
					variant="feature"
					quotes={[
						{
							quote:
								'Our error channel used to scroll past faster than anyone could read it, so nobody read it. Ferrite turned a week of noise into nine incidents, and we fixed six of them in an afternoon.',
							author: 'Lena Fischer',
							role: 'Platform Lead, Kestrel',
						},
					]}
				/>
			</Section>

			<Section id="faq" eyebrow="Questions" heading="Before you start">
				<FAQ
					items={[
						{ question: 'How long does setup take?', answer: 'About ten minutes. Point the collector at your existing log stream — there is no code change and no SDK to install.' },
						{ question: 'Do you store our raw logs?', answer: 'No. The collector extracts a fingerprint and a redacted sample, then discards the body. You can self-host it if you would rather we never saw either.' },
						{ question: 'What happens when we exceed the plan?', answer: 'Nothing breaks. We keep collecting and email you; you are never silently dropped mid-incident.' },
						{ question: 'Can we export our incidents?', answer: 'Everything is available as JSON from the API, and the incident history is yours to take if you leave.' },
					]}
				/>
			</Section>

			<CTASection
				headline="Find out what your logs have been hiding"
				subcopy="Connect a service and Ferrite ranks your first incidents within the hour."
				actions={
					<>
						<Button size="lg">Start free</Button>
						<Button size="lg" variant="outline">
							Read the docs
						</Button>
					</>
				}
				fineprint="No card required · 14-day Team trial · Cancel in one click"
			/>

			<Footer
				brand={
					<>
						<Layers className="size-4 text-primary" /> Ferrite
					</>
				}
				tagline="Ranked incidents from the logs you already have."
				columns={[
					{ heading: 'Product', links: ['Features', 'Pricing', 'Integrations', 'Changelog'] },
					{ heading: 'Developers', links: ['Docs', 'API', 'Collector', 'Status'] },
					{ heading: 'Company', links: ['About', 'Blog', 'Careers', 'Contact'] },
				]}
				fineprint="© 2026 Ferrite Labs. All rights reserved."
			/>
		</div>
	)
}
