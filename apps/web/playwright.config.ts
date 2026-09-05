import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet-landscape', use: { ...devices['iPad Pro 11 landscape'], browserName: 'chromium' } },
    { name: 'tablet-portrait', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
  ],
})
