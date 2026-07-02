// user.js — user data helpers.
function getUserData(id) {
	if (typeof id !== 'number' || id < 1) throw new Error('bad id')
	return { id, name: `user-${id}`, role: id === 1 ? 'admin' : 'member' }
}

function isAdmin(id) {
	return getUserData(id).role === 'admin'
}

function displayName(id) {
	const user = getUserData(id)
	return `${user.name} (${user.role})`
}

module.exports = { getUserData, isAdmin, displayName }
