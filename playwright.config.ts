import { defineConfig, devices } from '@playwright/test'

// One real-browser smoke test against the production build.
// The component tests (React Testing Library + jsdom, *.test.tsx next to
// each window) cover interaction logic; this exists specifically for the
// things jsdom can't: real layout/pointer-drag, real focus, real keyboard
// events, on the same `dist/` a deploy would actually serve.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  // Serves the already-built dist/ — `npm run test:e2e` builds first, and CI
  // has already run `npm run build` as its own step before this.
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
