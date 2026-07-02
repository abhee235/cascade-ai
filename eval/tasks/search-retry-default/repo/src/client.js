// client.js — construct a client whose config is defaults overlaid with caller options.
const { defaults } = require('./internal/defaults.js')
const { performRequest } = require('./http/request.js')

function createClient(options = {}) {
	const config = { ...defaults, ...options }
	return {
		config,
		request: (url) => performRequest(config, url),
	}
}

module.exports = { createClient }
