// resources.ts — where the server's SHIPPED assets live: skills, agents, project templates.
//
// These were resolved from `import.meta.dirname`, which is correct exactly once — when the server runs
// from its own source tree. A packaged desktop build bundles the code into a single file somewhere else
// entirely, so every one of those paths would point at a directory that does not exist, and the failure
// is silent in the worst way: no skills load, no agent definitions, no templates, and the app looks
// merely stupid rather than broken (ADR-081 §7).
//
// One override, set by whoever knows where the assets ended up. The Electron shell points it at the
// unpacked resources directory; nothing else needs to know.

import { join } from 'node:path'

/** The directory CONTAINING `skills/`, `agents/` and `templates/`. */
const ROOT = process.env.CASCADE_RESOURCES || join(import.meta.dirname, '..')

/** A path inside the shipped resources. */
export const resourceDir = (...parts: string[]) => join(ROOT, ...parts)
