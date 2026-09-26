import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Deterministic, headless tests of the core engine (no Ollama). E2E with a real model is the F5 check.
    // scripts/eval: the eval analyzer's classifier tests (PLAN-eval E4) — pure, offline.
    include: ['packages/*/test/**/*.test.ts', 'scripts/eval/**/*.test.mts'],
    environment: 'node',
    // ADR-070: the sandbox LIVE suites spawn real subprocesses (the tsx-hosted fence runner, Git Bash, the
    // Docker/WSL probes). Their COLD start — first-run tsx compile especially — exceeds vitest's 5s default
    // and flaked three tests on a fresh machine (2026-09-09; all passed in ~1s once warm). 20s clears the
    // cold path with margin while staying far below any "stuck forever" threshold.
    testTimeout: 20_000,
  },
})
