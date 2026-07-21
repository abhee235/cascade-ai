// prisma/seed.ts — load the app's existing seed data into the database.
// Run with:  npm run db:seed  (after db:migrate). Idempotent-ish: it only seeds an empty table, so
// re-running won't duplicate rows.
//
// Wire this to your real seeds: import the SAME arrays your prototype used from src/lib/data.ts, and
// upsert them per model. Keeping ONE seed source (src/lib/data.ts) means the DB matches what the app
// showed as a prototype.

import { PrismaClient } from '@prisma/client'
// import { SEED_RECIPES } from '../src/lib/data' // ← import your real seed array(s)

const prisma = new PrismaClient()

async function main() {
	// EXAMPLE — replace with your model(s):
	// const count = await prisma.recipe.count()
	// if (count === 0) {
	//   for (const r of SEED_RECIPES) await prisma.recipe.create({ data: r })
	//   console.log(`seeded ${SEED_RECIPES.length} recipes`)
	// } else {
	//   console.log(`recipes already seeded (${count}) — skipping`)
	// }
	console.log('seed: add your model(s) to this script')
}

main()
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
	.finally(() => prisma.$disconnect())
