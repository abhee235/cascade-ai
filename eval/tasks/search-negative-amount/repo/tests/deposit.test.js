const test = require('node:test')
const assert = require('node:assert')
const { deposit, openAccount } = require('../src/bank.js')
const { checkCurrency } = require('../src/validate/currency.js')

test('negative amounts are clamped to 0 (no throw)', () => {
	assert.strictEqual(deposit(100, -5), 100)
})

test('positive deposits still work', () => {
	assert.strictEqual(deposit(100, 25), 125)
})

test('non-numeric amounts still throw', () => {
	assert.throws(() => deposit(100, 'x'), /Invalid input/)
})

test('name validation still throws (unchanged)', () => {
	assert.throws(() => openAccount('  '), /Invalid input/)
	assert.deepStrictEqual(openAccount(' ada '), { name: 'ada', balance: 0 })
})

test('currency validation still throws (unchanged)', () => {
	assert.throws(() => checkCurrency('XXX'), /Invalid input/)
})
