// registry.js — vault shards self-register their passphrase fragment; ORDER (the shard number) matters.
const parts = []

function registerPart(order, word) {
	parts.push({ order, word })
}

module.exports = { parts, registerPart }
