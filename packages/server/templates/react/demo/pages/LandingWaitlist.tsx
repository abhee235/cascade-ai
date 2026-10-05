// REFERENCE PAGE — waitlist / early-access landing (category: landing, variant: waitlist). Authored
// for the `aurora-glass` preset. Never shipped to a project.
//
// The shortest landing archetype, and the one models over-build: there is ONE conversion (an email),
// so every band either earns the email or is cut. No pricing (there is nothing to buy yet), no feature
// bento, no long FAQ. Archetype: Hero(centered + inline capture) → LogoStrip → three steps → short FAQ
// → Footer(minimal).
//
// The capture form is the page's only interactive surface, so it carries the full forms contract:
// validate ON SUBMIT, one message per field, and a real success state that replaces the form rather
// than a toast that vanishes.

import { useState } from 'react'
import { CheckCircle2, Hourglass, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FAQ } from '@/components/blocks/FAQ'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { Logo } from '@/components/blocks/Logo'
import { LogoStrip } from '@/components/blocks/LogoStrip'
import { Section } from '@/components/blocks/Section'

const STEPS = [
	{ n: '01', title: 'Join the list', body: 'One email, no password. We use it to send exactly two things: your invite, and the note that it is coming.' },
	{ n: '02', title: 'We open in batches', body: 'Roughly two hundred a week, oldest first, so support stays answerable by the people who built it.' },
	{ n: '03', title: 'Bring your archive', body: 'Your first import runs on us — up to fifty thousand notes, with the folder structure intact.' },
]

export function LandingWaitlist() {
	const [email, setEmail] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [joined, setJoined] = useState(false)

	const submit = (e: React.FormEvent) => {
		e.preventDefault() // validate on SUBMIT, never on keystroke (forms skill)
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			setError('That does not look like an email address.')
			return
		}
		setError(null)
		setJoined(true)
	}

	return (
		<div>
			<Hero
				layout="centered"
				badge={
					<Badge variant="secondary" className="gap-1.5">
						<Hourglass className="size-3" /> 4,180 people ahead of you
					</Badge>
				}
				headline={
					<>
						Your notes, <span className="text-muted-foreground">finally searchable.</span>
					</>
				}
				subcopy="Sift reads every note you have ever written and answers questions about them. It runs on your machine — nothing leaves it."
				actions={
					// The whole conversion, inline in the hero: the ask is one field, so it does not deserve
					// its own screen. A success state REPLACES the form — never a toast the user can miss.
					joined ? (
						<div className="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-3 text-sm">
							<CheckCircle2 className="size-5 text-primary" />
							<span>
								You are in — we will email <span className="font-medium">{email}</span> when your invite is ready.
							</span>
						</div>
					) : (
						// noValidate is REQUIRED whenever you validate in JS: without it `type="email"` fires the
						// browser's own grey bubble first, your onSubmit never runs, and the user gets a message
						// in the browser's voice instead of yours. Keep type="email" — it still picks the right
						// mobile keyboard — and own the message.
						<form onSubmit={submit} noValidate className="flex w-full max-w-md flex-col gap-2">
							<div className="flex flex-col gap-2 sm:flex-row">
								<div className="flex-1">
									<Label htmlFor="waitlist-email" className="sr-only">
										Email address
									</Label>
									<Input
										id="waitlist-email"
										type="email"
										placeholder="you@example.com"
										value={email}
										aria-invalid={!!error}
										onChange={(e) => setEmail(e.target.value)}
									/>
								</div>
								<Button type="submit" size="lg">
									<Send className="size-4" /> Request an invite
								</Button>
							</div>
							{error ? <p className="text-left text-sm text-destructive">{error}</p> : null}
						</form>
					)
				}
			/>

			<Section compact>
				<LogoStrip variant="bare" label="Built by people from" items={['Kestrel', 'Northwind', 'Fieldwire', 'Osmond', 'Bellhop']} />
			</Section>

			<Section tone="muted" eyebrow="What happens next" heading="Three steps, then it is yours">
				{/* Numbered markers are honest here: this IS a sequence, and the order is the information. */}
				<div className="grid grid-cols-1 gap-8 md:grid-cols-3">
					{STEPS.map((s) => (
						<div key={s.n} className="flex flex-col gap-2">
							<span className="font-serif text-3xl font-semibold tabular-nums tracking-display text-muted-foreground/60">{s.n}</span>
							<h3 className="font-serif text-lg font-semibold tracking-display">{s.title}</h3>
							<p className="text-muted-foreground">{s.body}</p>
						</div>
					))}
				</div>
			</Section>

			<Section eyebrow="Questions" heading="The three we get most">
				<FAQ
					items={[
						{ question: 'Does anything leave my machine?', answer: 'No. The index and the model both run locally; the only network call Sift makes is a version check you can turn off.' },
						{ question: 'When will I get in?', answer: 'Invites go out oldest-first, about two hundred a week. At the current list length that is roughly five weeks.' },
						{ question: 'What will it cost?', answer: 'A one-time price, not a subscription. Everyone on the waitlist gets the launch price for a year after we open.' },
					]}
				/>
			</Section>

			<Footer
				brand={<Logo name="Sift" />}
				tagline="Local-first search for everything you have written."
				fineprint="© 2026 Sift. Nothing leaves your machine."
			/>
		</div>
	)
}
