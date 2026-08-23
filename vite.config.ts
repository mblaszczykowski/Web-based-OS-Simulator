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
    // Component tests opt into jsdom per file with a pragma, so the much
    // larger pure-logic suite keeps running in the faster node environment.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
