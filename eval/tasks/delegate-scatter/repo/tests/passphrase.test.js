const test = require('node:test')
const assert = require('node:assert')

// Self-deriving oracle: load the shards so their registerPart calls run, then the expected passphrase
// comes from the vault itself — the test cannot drift from the generated fixtures.
const { parts } = require('../src/vault/registry.js')
for (let n = 1; n <= 6; n++) require(`../src/vault/part${n}.js`)
const expected = parts
	.slice()
	.sort((a, b) => a.order - b.order)
	.map((p) => p.word)
	.join('-')

const { PASSPHRASE } = require('../src/config.js')

test('PASSPHRASE is assembled from all six shards in order', () => {
	assert.strictEqual(PASSPHRASE, expected)
})

test('all six shards contributed', () => {
	assert.strictEqual(parts.length, 6)
	assert.ok(PASSPHRASE.length > 0, 'seed must not pass')
})
