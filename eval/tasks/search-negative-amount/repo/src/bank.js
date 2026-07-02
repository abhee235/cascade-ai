// bank.js — account operations. All input validation lives under src/validate/.
const { checkAmount } = require('./validate/amount.js')
const { checkName } = require('./validate/name.js')

function deposit(balance, amount) {
	return balance + checkAmount(amount)
}

function openAccount(name) {
	return { name: checkName(name), balance: 0 }
}

module.exports = { deposit, openAccount }
