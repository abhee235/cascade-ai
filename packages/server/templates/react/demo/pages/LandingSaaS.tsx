// REFERENCE PAGE — SaaS landing (category: landing, variant: saas). Never shipped to a project; it is
// the human review gate and the source the generated `reference/pages-*.md` is cut from.
//
// The archetype, in order: Hero(collage) → LogoStrip → BentoGrid → PricingTable → Testimonial → FAQ →
// CTASection → Footer. Every band is a block with props; there is no bespoke CSS on this page.

import { GitBranch, Shield, Sparkles, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BentoGrid } from '@/components/blocks/BentoGrid'
import { CTASection } from '@/components/blocks/CTASection'
import { FAQ } from '@/components/blocks/FAQ'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { LogoStrip } from '@/components/blocks/LogoStrip'
import { PricingTable } from '@/components/blocks/PricingTable'
import { Section } from '@/components/blocks/Section'
import { Testimonial } from '@/components/blocks/Testimonial'
import { photo } from '@/lib/photos'

export function LandingSaaS() {
	return (
		<div>
			<Hero
				layout="collage"
				badge={
					<Badge variant="secondary" className="gap-1.5">
						<Sparkles className="size-3" /> Now with scheduled runs
					</Badge>
				}
				headline={
					<>
						Ship your pipeline, <span className="text-muted-foreground">not your weekend.</span>
					</>
				}
				subcopy="Cadence runs your data jobs on a schedule you can read, alerts the person who can fix them, and keeps a receipt for every run."
				actions={
					<>
						<Button size="lg">Start free</Button>
						<Button size="lg" variant="outline">
							Book a walkthrough
						</Button>
					</>
				}
				media={<img src={photo('workspace-code')} alt="The Cadence run timeline" />}
			/>

			<Section>
				<LogoStrip label="Running in production at" items={['Northwind', 'Kestrel', 'Bellhop', 'Trimble', 'Osmond', 'Fieldwire']} />
			</Section>

			<Section tone="muted" eyebrow="Why teams switch" heading="Everything a run needs, in one place" description="No glue scripts, no cron folklore, no Slack archaeology.">
				<BentoGrid
					tiles={[
						{
							kind: 'media',
							span: 2,
							title: 'Every run, on one timeline',
							description: 'Durations, retries, and the exact diff that changed behaviour.',
							media: <img src={photo('workspace-office')} alt="Run timeline" />,
						},
						{ kind: 'stat', value: '99.98%', label: 'Scheduler uptime, trailing 90 days' },
						{ kind: 'plain', icon: GitBranch, title: 'Branch-aware', description: 'Preview pipelines per PR, torn down on merge.' },
						{ kind: 'plain', icon: Shield, title: 'Secrets stay yours', description: 'BYO KMS; we never store decrypted values.' },
						{ kind: 'accent', title: 'Start with a template', description: 'Fourteen pipelines, ready to fork.', action: <Button variant="secondary">Browse templates</Button> },
					]}
				/>
			</Section>

			<Section eyebrow="Pricing" heading="Priced per pipeline, not per seat" description="Invite the whole team — you are billed for what actually runs.">
				<PricingTable
					tiers={[
						{
							name: 'Solo',
							price: '$0',
							period: 'mo',
							description: 'For one person and a side project.',
							features: ['3 pipelines', 'Hourly schedules', 'Community support'],
							action: <Button variant="outline">Start free</Button>,
						},
						{
							name: 'Team',
							price: '$49',
							period: 'mo',
							description: 'For a team that gets paged.',
							features: ['Unlimited pipelines', 'Minute-level schedules', 'On-call routing', 'Audit log'],
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
							quote: 'We deleted 4,000 lines of orchestration glue in a fortnight. The part I did not expect: our on-call pages dropped by half, because the alerts finally name the person who can fix the thing.',
							author: 'Priya Raman',
							role: 'Staff Data Engineer, Kestrel',
						},
					]}
				/>
			</Section>

			<Section eyebrow="Questions" heading="Before you start">
				<FAQ
					items={[
						{ question: 'Can I run it on my own infrastructure?', answer: 'Yes — the runner is a single binary. Self-hosted runners are on every plan, including free.' },
						{ question: 'What happens when a run fails at 3am?', answer: 'The run retries on your policy, then pages the owner of the failing step — not a shared channel nobody reads.' },
						{ question: 'How do I get my data out?', answer: 'Everything is exportable as JSON or Parquet from the API, and the schedules are plain YAML in your repo.' },
						{ question: 'Do you charge per seat?', answer: 'No. Invite everyone; pricing follows pipelines and run minutes.' },
					]}
				/>
			</Section>

			<CTASection
				headline="Put your first pipeline on a schedule tonight"
				subcopy="Fork a template, point it at your warehouse, and watch the first run land."
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
						<Zap className="size-4 text-primary" /> Cadence
					</>
				}
				tagline="Scheduled data pipelines with receipts."
				columns={[
					{ heading: 'Product', links: ['Pipelines', 'Schedules', 'Alerting', 'Pricing'] },
					{ heading: 'Developers', links: ['Docs', 'API', 'Runners', 'Status'] },
					{ heading: 'Company', links: ['About', 'Blog', 'Careers', 'Contact'] },
				]}
				fineprint="© 2026 Cadence Labs. All rights reserved."
			/>
		</div>
	)
}
