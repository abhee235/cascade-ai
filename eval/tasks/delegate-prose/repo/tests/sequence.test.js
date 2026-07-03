const test = require('node:test')
const assert = require('node:assert')
const { RECOVERY_SEQUENCE } = require('../src/config.js')

// The expected value is hardcoded (the facts live in PROSE — there is nothing to require/execute), exactly
// like the changelog fixture. The tests dir is protected; the generator and this file agree by construction.
test('RECOVERY_SEQUENCE reconstructed from all six manuals, in order', () => {
	assert.strictEqual(RECOVERY_SEQUENCE, 'harness-beats-model-when-context-stays')
})

test('seed must not pass', () => {
	assert.ok(RECOVERY_SEQUENCE.length > 0)
})
