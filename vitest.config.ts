import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Deterministic, headless tests of the core engine (no Ollama). E2E with a real model is the F5 check.
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
})
