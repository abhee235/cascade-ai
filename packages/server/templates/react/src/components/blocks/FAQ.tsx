import type { ReactNode } from 'react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'

export interface FaqItem {
	question: string
	answer: ReactNode
}

export interface FAQProps {
	items: FaqItem[]
	/** Open the first question by default — good for a short list, noise for a long one. */
	defaultOpenFirst?: boolean
	className?: string
}

/** FAQ — the objection-handling band near the end of a landing page. Answer the questions that actually
 *  block a purchase (price, cancellation, data, support), not the ones that flatter the product. */
export function FAQ({ items, defaultOpenFirst = true, className }: FAQProps) {
	return (
		<div data-block="faq" className={cn('mx-auto w-full max-w-3xl', className)}>
			<Accordion type="single" collapsible defaultValue={defaultOpenFirst && items[0] ? 'item-0' : undefined}>
				{items.map((item, i) => (
					<AccordionItem key={item.question} value={`item-${i}`}>
						<AccordionTrigger>{item.question}</AccordionTrigger>
						<AccordionContent>{item.answer}</AccordionContent>
					</AccordionItem>
				))}
			</Accordion>
		</div>
	)
}
