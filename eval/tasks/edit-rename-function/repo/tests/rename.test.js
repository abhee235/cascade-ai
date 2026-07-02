const test = require('node:test')
const assert = require('node:assert')
const user = require('../src/user.js')

test('fetchUserProfile exists and behaves like the old function', () => {
	assert.strictEqual(typeof user.fetchUserProfile, 'function')
	assert.deepStrictEqual(user.fetchUserProfile(2), { id: 2, name: 'user-2', role: 'member' })
})

test('the old export name is gone', () => {
	assert.strictEqual(user.getUserData, undefined)
})

test('call sites still work through the rename', () => {
	assert.strictEqual(user.isAdmin(1), true)
	assert.strictEqual(user.displayName(3), 'user-3 (member)')
})
