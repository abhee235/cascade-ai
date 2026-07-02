// stats.js — basic descriptive statistics.
function mean(numbers) {
	return numbers.reduce((a, b) => a + b, 0) / numbers.length
}

function median(numbers) {
	const sorted = numbers.slice().sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

module.exports = { mean, median }
