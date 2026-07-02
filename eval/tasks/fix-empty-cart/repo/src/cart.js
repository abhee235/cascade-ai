// cart.js — shopping cart helpers. Items look like { name, price, qty }.
function cartTotal(items) {
	return items.map((i) => i.price * i.qty).reduce((a, b) => a + b)
}

function cheapest(items) {
	return items.slice().sort((a, b) => a.price - b.price)[0].name
}

module.exports = { cartTotal, cheapest }
