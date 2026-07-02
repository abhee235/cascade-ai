// name.js — validate account holder names. (Also throws "Invalid input" — a decoy for naive grepping:
// this one must KEEP throwing.)
function checkName(name) {
	if (typeof name !== 'string' || name.trim() === '') throw new Error('Invalid input')
	return name.trim()
}

module.exports = { checkName }
