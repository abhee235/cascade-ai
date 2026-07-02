const test = require('node:test')
const assert = require('node:assert')
const { formatDuration } = require('../src/format.js')

test('under a minute', () => {
	assert.strictEqual(formatDuration(59), '0m 59s')
})

test('exact minutes', () => {
	assert.strictEqual(formatDuration(600), '10m 00s')
})

test('durations of an hour or more include an hours part', () => {
	assert.strictEqual(formatDuration(3723), '1h 02m 03s')
})

test('multiple hours', () => {
	assert.strictEqual(formatDuration(7325), '2h 02m 05s')
})
