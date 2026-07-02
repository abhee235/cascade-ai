// amount.js — validate and normalize monetary amounts.
function checkAmount(amount) {
	if (typeof amount !== 'number' || Number.isNaN(amount)) throw new Error('Invalid input')
	if (amount < 0) throw new Error('Invalid input')
	return amount
}

module.exports = { checkAmount }
