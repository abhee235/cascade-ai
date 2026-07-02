const test = require('node:test')
const assert = require('node:assert')
const { createClient } = require('../src/index.js')

test('default retry count is 3', () => {
	assert.strictEqual(createClient().config.retries, 3)
})

test('a request is attempted 1 + retries times by default', () => {
	assert.strictEqual(createClient().request('http://x').attempts, 4)
})

test('other defaults are unchanged', () => {
	const { config } = createClient()
	assert.strictEqual(config.timeoutMs, 5000)
	assert.strictEqual(config.backoffMs, 250)
	assert.strictEqual(config.keepAlive, true)
})

test('caller options still override the default', () => {
	assert.strictEqual(createClient({ retries: 0 }).config.retries, 0)
})
