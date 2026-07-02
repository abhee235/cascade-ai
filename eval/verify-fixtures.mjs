// verify-fixtures.mjs — the fixture invariant (PLAN-eval E2): every task's check must FAIL on the seed
// repo and PASS once solution/ is overlaid. Run after adding or changing any fixture:
//   node eval/verify-fixtures.mjs
// Exit 0 = all fixtures sound; exit 1 = at least one violates the invariant (table shows which).

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tasksDir = join(dirname(fileURLToPath(import.meta.url)), 'tasks')

function runCheck(command, cwd) {
	// shell:true → the check string runs as-is on both Windows and POSIX.
	const res = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 120_000 })
	return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const ids = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, 'task.json')))
let failures = 0
const rows = []

for (const id of ids) {
	const task = JSON.parse(readFileSync(join(tasksDir, id, 'task.json'), 'utf8'))
	const work = mkdtempSync(join(tmpdir(), `cascade-eval-${id}-`))
	try {
		cpSync(join(tasksDir, id, 'repo'), work, { recursive: true })
		const seed = runCheck(task.check, work)

		cpSync(join(tasksDir, id, 'solution'), work, { recursive: true }) // overlay the hand-made fix
		const solved = runCheck(task.check, work)

		const seedOk = !seed.ok // invariant: seed must FAIL
		const solvedOk = solved.ok // invariant: solution must PASS
		if (!seedOk || !solvedOk) {
			failures++
			// Show the tail of the offending run so the fixture author sees WHY.
			const bad = !seedOk ? { label: 'seed unexpectedly PASSED', out: seed.output } : { label: 'solution FAILED', out: solved.output }
			console.error(`\n--- ${id}: ${bad.label} ---\n${bad.out.slice(-1500)}`)
		}
		rows.push({ id, tags: task.tags.join(','), 'seed fails': seedOk ? '✅' : '❌', 'solution passes': solvedOk ? '✅' : '❌' })
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

console.table(rows)
console.log(failures === 0 ? `All ${ids.length} fixtures sound.` : `${failures}/${ids.length} fixtures VIOLATE the invariant.`)
process.exit(failures === 0 ? 0 : 1)
