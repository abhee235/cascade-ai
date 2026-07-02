const test = require('node:test')
const assert = require('node:assert')

test('stats module: mean and median', () => {
	const { mean, median } = require('../src/stats.js')
	assert.strictEqual(mean([2, 4, 6]), 4)
	assert.strictEqual(median([1, 3, 5]), 3)
	assert.strictEqual(median([1, 2, 3, 4]), 2.5)
	const input = [3, 1, 2]
	median(input)
	assert.deepStrictEqual(input, [3, 1, 2]) // input not mutated
})

test('report includes mean and median of the totals', () => {
	const { buildReport } = require('../src/report.js')
	const report = buildReport()
	assert.strictEqual(report.count, 6)
	assert.strictEqual(report.max, 42)
	assert.strictEqual(report.mean, 18)
	assert.strictEqual(report.median, 15.5)
})
