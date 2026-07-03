import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Deterministic, headless tests of the core engine (no Ollama). E2E with a real model is the F5 check.
    // scripts/eval: the eval analyzer's classifier tests (PLAN-eval E4) — pure, offline.
    include: ['packages/*/test/**/*.test.ts', 'scripts/eval/**/*.test.mts'],
    environment: 'node',
  },
})
