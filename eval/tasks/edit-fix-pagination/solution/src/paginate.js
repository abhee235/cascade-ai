// paginate.js — slice a list into pages. Page numbers are 1-based.
function paginate(items, page, perPage) {
	const start = (page - 1) * perPage
	return items.slice(start, start + perPage)
}

function pageCount(items, perPage) {
	return Math.ceil(items.length / perPage)
}

module.exports = { paginate, pageCount }
