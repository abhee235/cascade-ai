export interface Product {
	id: string
	name: string
	price: number
	description: string
	category: string
}

export interface CartLine {
	productId: string
	qty: number
}

export interface Order {
	lines: CartLine[]
	total: number
	timestamp: number
}
