// _generate-longctx.mjs — regenerate the BULK files of the two longctx fixtures. Deterministic (no
// randomness): run `node eval/tasks/_generate-longctx.mjs` from the repo root after changing this file.
// The bulk is the point — these fixtures must force multiple large Reads so compaction fires on a small
// (8k, pinned via task.json `session.contextWindow`) window. Needles are planted mid-file so a partial
// read misses them.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const write = (rel, content) => {
	const abs = join(here, rel)
	mkdirSync(dirname(abs), { recursive: true })
	writeFileSync(abs, content, 'utf8')
	console.log(`wrote ${rel} (${content.split('\n').length} lines)`)
}

// ── longctx-wire-modules: four large stage files, each with one registerStage needle ─────────────────────
const STAGES = [
	{ name: 'ingest', priority: 10, verb: 'pull raw records from the source adapters' },
	{ name: 'validate', priority: 20, verb: 'reject or repair records that violate the schema' },
	{ name: 'emit', priority: 30, verb: 'hand finished batches to the downstream sinks' },
	{ name: 'transform', priority: 40, verb: 'reshape validated records into the output schema' },
]

function helperFn(stage, i) {
	return `/**
 * ${stage}Step${i} — internal helper ${i} for the ${stage} stage.
 * Contract: pure — returns a new object, never mutates, never throws on missing fields.
 */
function ${stage}Step${i}(record) {
	const shaped = { ...record, stage: '${stage}', step: ${i} }
	if (shaped.payload == null) shaped.payload = ''
	shaped.checksum = (String(shaped.payload).length * ${i + 3}) % 9973
	shaped.trail = [...(shaped.trail ?? []), '${stage}:${i}']
	return shaped
}
`
}

for (const s of STAGES) {
	const HELPERS = 42
	const needleAt = Math.floor(HELPERS * 0.62) // buried ~62% in — a head-only read misses it
	const parts = [
		`// ${s.name}.js — the ${s.name} stage: ${s.verb}.`,
		`// (Generated fixture — the bulk is intentional; see eval/tasks/_generate-longctx.mjs.)`,
		`'use strict'`,
		`const { registerStage } = require('./registry.js')`,
		``,
	]
	for (let i = 1; i <= HELPERS; i++) {
		parts.push(helperFn(s.name, i))
		if (i === needleAt) {
			parts.push(`// Wire this stage into the pipeline. Lower priority runs earlier.`)
			parts.push(`registerStage('${s.name}', ${s.priority})`)
			parts.push(``)
		}
	}
	parts.push(`module.exports = { ${s.name}Step1, ${s.name}Step${HELPERS} }`)
	parts.push(``)
	write(`longctx-wire-modules/repo/src/pipeline/${s.name}.js`, parts.join('\n'))
}

// ── longctx-changelog-version: a long CHANGELOG.md + docs/UPGRADING.md with decoy values ─────────────────
const releases = []
for (let minor = 4; minor >= 0; minor--) releases.push(`2.${minor}.0`)
for (let minor = 6; minor >= 0; minor--) releases.push(`1.${minor}.0`)
for (let minor = 9; minor >= 1; minor--) releases.push(`0.${minor}.0`)

const AREAS = ['core', 'cli', 'parser', 'cache', 'transport', 'config', 'logging', 'metrics']
function releaseSection(version, index) {
	const [major, minor] = version.split('.').map(Number)
	const lines = [`## ${version} (${2026 - Math.floor(index / 4)}-${String((index % 12) + 1).padStart(2, '0')}-14)`, ``]
	// Migration-target lines appear on every 2.x release — DECOYS for grep; only the latest release's counts.
	if (major === 2) {
		const targets = minor >= 2 ? `${major}.${minor - 2}, ${major}.${minor - 1}` : `${major}.${Math.max(0, minor - 1)}`
		lines.push(`Supported migration targets for this release: ${targets}.`, ``)
	}
	for (let i = 0; i < 10; i++) {
		const area = AREAS[(index + i) % AREAS.length]
		lines.push(`- ${area}: ${['fix', 'improve', 'rework', 'document'][i % 4]} ${area} behaviour for case ${index * 10 + i} (see #${1000 + index * 10 + i}).`)
	}
	lines.push(``)
	return lines.join('\n')
}
const changelog = [
	`# Changelog`,
	``,
	`All notable changes to this project are documented here. Newest first.`,
	``,
	`## Unreleased`,
	``,
	`- (nothing yet)`,
	``,
	...releases.map((v, i) => releaseSection(v, i)),
].join('\n')
write('longctx-changelog-version/repo/CHANGELOG.md', changelog)

const upgradingParas = []
for (let i = 1; i <= 30; i++) {
	upgradingParas.push(`### Step ${i}: review your ${AREAS[i % AREAS.length]} configuration

When upgrading across a major boundary, audit the ${AREAS[i % AREAS.length]} settings introduced in earlier
releases. Defaults may have changed; the migration tool rewrites what it can and reports the rest. Run the
checker twice — once before and once after — and diff the reports (case ${i}).`)
	if (i === 11) {
		upgradingParas.push(`### Runtime requirements

During the 1.x series the minimum supported Node version was 14, and early 2.x releases accepted 16.
**As of the current release the minimum supported Node version is 20.** Older runtimes fail at install time.`)
	}
}
write(
	'longctx-changelog-version/repo/docs/UPGRADING.md',
	[`# Upgrading guide`, ``, `Work through the steps in order. Historical notes are kept for context —`, `always prefer the statements marked "as of the current release".`, ``, ...upgradingParas, ``].join('\n\n'),
)

// ── delegate-scatter: SIX large vault files, one passphrase fragment each (delegation-pressure fixture) ──
// Design: ~30k tokens of required reading vs an 8k pinned window. A solo agent must compact repeatedly
// (and masking can elide needles it read earlier); delegating per-file reads to subagents keeps the parent
// lean. The prompt stays NEUTRAL — we measure whether delegation happens, we don't instruct it (the
// `subagentCalls` metric + compactions tell the story).
const WORDS = ['cascade', 'delegates', 'exploration', 'to', 'focused', 'subagents']
for (let n = 1; n <= 6; n++) {
	const parts = [
		`// part${n}.js — vault shard ${n} of 6. (Generated fixture — bulk is intentional.)`,
		`'use strict'`,
		`const { registerPart } = require('./registry.js')`,
		``,
	]
	const HELPERS = 40
	const needleAt = Math.floor(HELPERS * (0.35 + n * 0.08)) // varied depth per file — no fixed offset to exploit
	for (let i = 1; i <= HELPERS; i++) {
		parts.push(`/**
 * shard${n}Op${i} — maintenance routine ${i} for vault shard ${n}.
 * Contract: pure; returns a fresh audit record; tolerates missing fields.
 */
function shard${n}Op${i}(entry) {
	const audit = { ...entry, shard: ${n}, op: ${i} }
	audit.digest = (String(audit.payload ?? '').length * ${i + n}) % 7919
	audit.trail = [...(audit.trail ?? []), 'shard${n}:${i}']
	return audit
}
`)
		if (i === needleAt) {
			parts.push(`// Shard ${n}'s fragment of the recovery passphrase. Order matters.`)
			parts.push(`registerPart(${n}, '${WORDS[n - 1]}')`)
			parts.push(``)
		}
	}
	parts.push(`module.exports = { shard${n}Op1, shard${n}Op${HELPERS} }`)
	parts.push(``)
	write(`delegate-scatter/repo/src/vault/part${n}.js`, parts.join('\n'))
}
