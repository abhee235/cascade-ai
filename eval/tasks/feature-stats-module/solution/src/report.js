// report.js — build the summary report from the dataset.
const { totals } = require('./data.js')
const { mean, median } = require('./stats.js')

function buildReport() {
	return {
		count: totals.length,
		max: Math.max(...totals),
		mean: mean(totals),
		median: median(totals),
	}
}

module.exports = { buildReport }
