// The SQLite adapter, run against the SHARED port suite (@cascade/storage/conformance).
//
// This file is deliberately tiny: the tests are not here, they belong to the PORT. A second adapter
// (Postgres, SQL Server) gets a file exactly like this one — same suite, different factories — and is
// finished when it goes green. That is what makes "swap the backend" checkable rather than aspirational.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConformance } from '@cascade/storage/conformance'
import { openDb } from '../src/db.js'
import { createTraceStore } from '../src/traceStore.js'
import { createConfigStore } from '../src/configStore.js'
import { createChatStore } from '../src/chatStore.js'

/** A fresh, migrated database per store — the suite requires stores that cannot see each other's rows. */
const freshDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'cascade-conformance-')), 'cascade.db'))

runConformance(
	{
		name: 'sqlite',
		makeTraceStore: () => createTraceStore(freshDb()),
		makeConfigStore: () => createConfigStore(freshDb()),
		makeChatStore: () => createChatStore(freshDb()),
	},
	{ describe, it, expect },
)
