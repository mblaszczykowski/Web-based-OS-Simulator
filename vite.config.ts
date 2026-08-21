/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works unmodified on GitHub Pages project sites
// (github.io/<repo>/) as well as locally via `vite preview`.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    // Component tests (roadmap-v3.md §2.4) opt into jsdom per-file via a
    // `// @vitest-environment jsdom` pragma at the top of the file, so the
    // much larger pure-logic engine test suite keeps running in the
    // faster default `node` environment instead of paying a DOM-setup
    // cost it never needs.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
