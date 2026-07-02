const test = require('node:test')
const assert = require('node:assert')
const { cartTotal, cheapest } = require('../src/cart.js')

const items = [
	{ name: 'pen', price: 2, qty: 3 },
	{ name: 'pad', price: 5, qty: 1 },
]

test('total of a non-empty cart', () => {
	assert.strictEqual(cartTotal(items), 11)
})

test('cheapest of a non-empty cart', () => {
	assert.strictEqual(cheapest(items), 'pen')
})

test('total of an empty cart is 0', () => {
	assert.strictEqual(cartTotal([]), 0)
})

test('cheapest of an empty cart is null', () => {
	assert.strictEqual(cheapest([]), null)
})
