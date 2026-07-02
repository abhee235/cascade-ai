const test = require('node:test')
const assert = require('node:assert')
const { paginate, pageCount } = require('../src/paginate.js')

test('page 1 returns the first items', () => {
	assert.deepStrictEqual(paginate(['a', 'b', 'c', 'd'], 1, 2), ['a', 'b'])
})

test('page 2 returns the next items', () => {
	assert.deepStrictEqual(paginate(['a', 'b', 'c', 'd'], 2, 2), ['c', 'd'])
})

test('last partial page returns the remainder', () => {
	assert.deepStrictEqual(paginate(['a', 'b', 'c', 'd', 'e'], 3, 2), ['e'])
})

test('pageCount unchanged', () => {
	assert.strictEqual(pageCount(['a', 'b', 'c', 'd', 'e'], 2), 3)
})
