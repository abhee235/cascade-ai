const test = require('node:test')
const assert = require('node:assert')
const { run, commands } = require('../src/registry.js')

test('remove is registered', () => {
	assert.strictEqual(commands.has('remove'), true)
})

test('remove drops the first occurrence only', () => {
	assert.deepStrictEqual(run('remove', ['a', 'b', 'a'], 'a'), ['b', 'a'])
})

test('remove of an absent item leaves the list unchanged', () => {
	assert.deepStrictEqual(run('remove', ['a', 'b'], 'x'), ['a', 'b'])
})

test('remove does not mutate the input state', () => {
	const state = ['a', 'b']
	run('remove', state, 'a')
	assert.deepStrictEqual(state, ['a', 'b'])
})

test('existing commands still work', () => {
	assert.deepStrictEqual(run('add', ['a'], 'b'), ['a', 'b'])
	assert.deepStrictEqual(run('list', ['a', 'b']), ['a', 'b'])
})
