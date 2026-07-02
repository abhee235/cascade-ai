// cart.js — shopping cart helpers. Items look like { name, price, qty }.
function cartTotal(items) {
	return items.map((i) => i.price * i.qty).reduce((a, b) => a + b, 0)
}

function cheapest(items) {
	if (items.length === 0) return null
	return items.slice().sort((a, b) => a.price - b.price)[0].name
}

module.exports = { cartTotal, cheapest }
