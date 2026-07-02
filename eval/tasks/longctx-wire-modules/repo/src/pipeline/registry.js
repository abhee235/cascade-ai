// registry.js — pipeline stages self-register with a priority; LOWER priority runs EARLIER.
const stages = []

function registerStage(name, priority) {
	stages.push({ name, priority })
}

module.exports = { stages, registerStage }
