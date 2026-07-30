// The extension's bundled skills (the lazily-loaded-playbook pattern): shipped with the
// extension, loaded as the BASE skillDirs entry, shadowable by ~/.cascade/skills and workspace skills.

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkills } from '@cascade/core'

const bundledDir = join(__dirname, '..', 'skills')

describe('extension bundled skills', () => {
	it('new-app loads with name, description, and the verify-with-audit playbook', () => {
		const skills = loadSkills([bundledDir])
		const newApp = skills.find((s) => s.name === 'new-app')
		expect(newApp).toBeDefined()
		expect(newApp!.description).toContain('scaffold')
		expect(newApp!.body).toContain('npm create vite@latest')
		expect(newApp!.body).toContain('audit') // the mandatory Browser audit step rides along
		expect(newApp!.body).toContain('do not edit its root package.json') // the monorepo-pollution lesson
	})

	it('a workspace skill with the same name SHADOWS the bundled one (dir order)', () => {
		const skills = loadSkills([bundledDir, join(__dirname, 'fixtures', 'shadow-skills')])
		const newApp = skills.find((s) => s.name === 'new-app')
		expect(newApp!.body).toContain('SHADOWED')
	})
})
