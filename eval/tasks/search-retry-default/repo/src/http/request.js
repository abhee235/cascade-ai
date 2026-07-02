// request.js — attempt a request up to `config.retries + 1` times with backoff between attempts.
const { nextBackoff } = require('../util/backoff.js')
const { log } = require('../util/log.js')

function performRequest(config, url) {
	const attempts = []
	for (let attempt = 0; attempt <= config.retries; attempt++) {
		attempts.push({ attempt, url, backoffMs: attempt === 0 ? 0 : nextBackoff(config.backoffMs, attempt) })
		log(`attempt ${attempt} → ${url}`)
	}
	// (Simulated transport: this fixture only models the retry schedule, not real I/O.)
	return { url, attempts: attempts.length, schedule: attempts }
}

module.exports = { performRequest }
