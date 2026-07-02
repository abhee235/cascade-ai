const test = require('node:test')
const assert = require('node:assert')
const meta = require('../src/meta.js')

test('CURRENT_VERSION is the latest released version', () => {
	assert.strictEqual(meta.CURRENT_VERSION, '2.4.0')
})

test('MIN_NODE is the current minimum supported Node major', () => {
	assert.strictEqual(meta.MIN_NODE, 20)
})

test('MIGRATION_TARGETS come from the latest release notes', () => {
	assert.deepStrictEqual(meta.MIGRATION_TARGETS, ['2.2', '2.3'])
})
