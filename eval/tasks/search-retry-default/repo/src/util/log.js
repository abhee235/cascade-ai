// log.js — minimal logger. `retries` mentioned here refers to LOG WRITE retries (a decoy — not the
// client's request-retry default).
const LOG_WRITE_RETRIES = 2
const lines = []

function log(message) {
	lines.push(String(message))
}

module.exports = { log, lines, LOG_WRITE_RETRIES }
