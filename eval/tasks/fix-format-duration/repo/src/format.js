// format.js — human-readable durations from a number of seconds (>= 0).
function formatDuration(totalSeconds) {
	const m = Math.floor(totalSeconds / 60)
	const s = totalSeconds % 60
	return `${m}m ${String(s).padStart(2, '0')}s`
}

module.exports = { formatDuration }
