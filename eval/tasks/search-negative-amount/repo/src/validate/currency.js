// currency.js — validate ISO currency codes. (Another "Invalid input" thrower; unrelated to deposits.)
const KNOWN = new Set(['USD', 'EUR', 'INR', 'GBP', 'JPY'])

function checkCurrency(code) {
	if (!KNOWN.has(code)) throw new Error('Invalid input')
	return code
}

module.exports = { checkCurrency }
