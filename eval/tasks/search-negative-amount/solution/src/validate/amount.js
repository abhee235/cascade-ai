// amount.js — validate and normalize monetary amounts. Negative amounts are clamped to 0.
function checkAmount(amount) {
	if (typeof amount !== 'number' || Number.isNaN(amount)) throw new Error('Invalid input')
	if (amount < 0) return 0
	return amount
}

module.exports = { checkAmount }
