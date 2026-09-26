// lib/types.ts — Studio Manager's data shapes, mirroring the Prisma models + API payloads.

export interface Client {
	id: number
	name: string
	email: string
	company?: string | null
	createdAt: string
}

export interface InvoiceItem {
	id?: number
	description: string
	qty: number
	unitPrice: number
}

export type InvoiceStatus = 'draft' | 'sent' | 'paid'

export interface Invoice {
	id: number
	clientId: number
	clientName: string
	status: InvoiceStatus
	createdAt: string
	items: InvoiceItem[]
	/** Server-computed Σ qty×unitPrice, rounded to 2 decimals — never recompute client-side. */
	total: number
}

export interface Stats {
	clients: number
	invoices: number
	outstandingTotal: number
	paidTotal: number
	revenueByMonth: { month: string; total: number }[]
}

/** The list envelope every collection endpoint returns (round 6): total is the FULL filtered count. */
export interface ListEnvelope<T> {
	items: T[]
	total: number
}
