import { defineConfig } from '@playwright/test';

/**
 * Browser workflow suite for PRD v1.2 section 10.4.
 *
 * The server is started by boot-test-server.js, which uses its own XDG directories and its own
 * owner account, so browser tests never touch the real configuration.
 *
 * Install browsers once with: npx playwright install chromium
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  webServer: {
    // Playwright runs this with the config directory as the working directory.
    command: 'node boot-test-server.js',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: false,
    timeout: 90_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8080',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'android-viewport', use: { browserName: 'chromium', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } },
  ],
});
