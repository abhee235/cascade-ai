const test = require('node:test')
const assert = require('node:assert')

// Behavioural oracle: import the stage modules so their registerStage calls run, then the declared
// STAGE_SEQUENCE must equal the registered stages sorted by ascending priority.
const { stages } = require('../src/pipeline/registry.js')
require('../src/pipeline/ingest.js')
require('../src/pipeline/transform.js')
require('../src/pipeline/validate.js')
require('../src/pipeline/emit.js')
const { STAGE_SEQUENCE } = require('../src/pipeline/order.js')

test('all four stages are declared', () => {
	assert.strictEqual(STAGE_SEQUENCE.length, 4)
})

test('STAGE_SEQUENCE matches the registered priorities (ascending)', () => {
	const expected = stages
		.slice()
		.sort((a, b) => a.priority - b.priority)
		.map((s) => s.name)
	assert.deepStrictEqual(STAGE_SEQUENCE, expected)
})
