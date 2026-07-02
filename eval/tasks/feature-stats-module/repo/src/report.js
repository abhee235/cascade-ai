// report.js — build the summary report from the dataset.
const { totals } = require('./data.js')

function buildReport() {
	return {
		count: totals.length,
		max: Math.max(...totals),
	}
}

module.exports = { buildReport }
