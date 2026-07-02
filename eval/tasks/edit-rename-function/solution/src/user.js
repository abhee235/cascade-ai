// user.js — user data helpers.
function fetchUserProfile(id) {
	if (typeof id !== 'number' || id < 1) throw new Error('bad id')
	return { id, name: `user-${id}`, role: id === 1 ? 'admin' : 'member' }
}

function isAdmin(id) {
	return fetchUserProfile(id).role === 'admin'
}

function displayName(id) {
	const user = fetchUserProfile(id)
	return `${user.name} (${user.role})`
}

module.exports = { fetchUserProfile, isAdmin, displayName }
