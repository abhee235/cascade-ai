// backoff.js — exponential backoff schedule. NOTE: `attempt` here is 1-based; this module has its own
// internal retry cap for the schedule table, which is NOT the client's retry default.
const MAX_SCHEDULE_ENTRIES = 8

function nextBackoff(baseMs, attempt) {
	return Math.min(baseMs * 2 ** Math.min(attempt - 1, MAX_SCHEDULE_ENTRIES), 30_000)
}

module.exports = { nextBackoff, MAX_SCHEDULE_ENTRIES }
