// format.js — human-readable durations from a number of seconds (>= 0).
function formatDuration(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600)
	const m = Math.floor((totalSeconds % 3600) / 60)
	const s = totalSeconds % 60
	if (h > 0) {
		return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
	}
	return `${m}m ${String(s).padStart(2, '0')}s`
}

module.exports = { formatDuration }
