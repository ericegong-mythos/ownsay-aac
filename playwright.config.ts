import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const baseURL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-fire',
      testMatch: /fire7-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 600 }, hasTouch: true, launchOptions: { args: ['--mute-audio'] } },
    },
    { name: 'chromium-desktop', testIgnore: /fire7-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, launchOptions: { args: ['--mute-audio'] } } },
    { name: 'chromium-mobile', testIgnore: /fire7-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true, launchOptions: { args: ['--mute-audio'] } } },
    { name: 'chromium-tablet', testIgnore: /fire7-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, hasTouch: true, launchOptions: { args: ['--mute-audio'] } } },
    { name: 'webkit-desktop', testIgnore: /fire7-.*\.spec\.ts/, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } },
    { name: 'webkit-mobile', testIgnore: /fire7-.*\.spec\.ts/, use: { ...devices['Desktop Safari'], viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
})
