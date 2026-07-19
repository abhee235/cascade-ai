// checkProject.ts — run a TypeScript check INSIDE the project's sandbox and parse the result into structured
// problems for the Problems panel (M5.3). Server-only; the wrapper relays them as a `problems` BuilderEvent.

import type { Sandbox } from '@cascade/core'
import type { Problem } from '@cascade/app-protocol'

// `tsc --pretty false` prints one error per line: `src/App.tsx(12,7): error TS2304: Cannot find name 'x'.`
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/

/** Type-check the project (`tsc --noEmit`) in its sandbox; return the errors as structured problems. */
export async function runCheck(sandbox: Sandbox): Promise<Problem[]> {
  // --pretty false keeps each error on one line (no colour/codeframe) so it parses cleanly. 2>&1 because tsc
  // writes some output to stderr. A non-zero exit just means "there were errors" — we read them from output.
  // node_modules/.bin/tsc, never bare `npx tsc`: without a local install npx fetches the FAKE tsc package
  // ("This is not the tsc command you are looking for") and the panel would silently show zero problems.
  const { output } = await sandbox.exec('node_modules/.bin/tsc --noEmit --pretty false 2>&1')
  const problems: Problem[] = []
  for (const raw of output.split('\n')) {
    const m = TSC_LINE.exec(raw.trim())
    if (m) problems.push({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]), col: Number(m[3]), message: m[4] })
  }
  return problems
}
