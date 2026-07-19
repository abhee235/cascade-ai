// ADR-032 — a successful Write records freshness, so Write→Edit works without a wasted re-read turn.
// Measured (Simmer run 5): two Write→Edit pairs each paid "File has been modified since you read it" +
// a re-read, for files the model itself had just written.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WriteTool } from '../src/tools/builtins/Write'
import { EditTool } from '../src/tools/builtins/Edit'
import { FileStateCache } from '../src/tools/fileState'
import type { ToolContext } from '../src/tools/Tool'

describe('Write → Edit freshness (ADR-032)', () => {
	it('an Edit right after a Write succeeds with no intervening Read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'writefresh-'))
		const ctx = { cwd: dir, abortSignal: new AbortController().signal, depth: 0, readFileState: new FileStateCache() } as unknown as ToolContext
		const w = await WriteTool.call({ file_path: 'src/App.tsx', content: 'const view = 1\nexport default view\n' }, ctx)
		expect(w.isError).toBeFalsy()
		const e = await EditTool.call({ file_path: 'src/App.tsx', old_string: 'const view = 1', new_string: 'const view = 2' }, ctx)
		expect(e.isError).toBeFalsy()
		rmSync(dir, { recursive: true, force: true })
	})
})
