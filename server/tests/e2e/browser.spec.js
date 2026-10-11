/**
 * Playwright browser workflows. These require a running server and an owner account; see
 * docs/setup.md. The desktop and Android viewport projects are configured in playwright.config.json.
 *
 * These tests are the automated portion of PRD v1.2 section 10.4. A real Android Chrome smoke
 * test on a physical device remains a manual release gate.
 */
import { test, expect } from '@playwright/test';

test.describe('Remote Terminal browser workflows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('login screen rejects bad credentials and accepts good ones', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Remote Terminal' })).toBeVisible();
    await page.getByLabel('Owner username').fill('sank');
    await page.getByLabel('Password').fill('wrong password entirely 1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.error-text')).toBeVisible();

    await page.getByLabel('Password').fill(process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  });

  test('create a terminal, run a command, switch tabs, refresh and reattach', async ({ page }) => {
    await page.getByLabel('Owner username').fill('sank');
    await page.getByLabel('Password').fill(process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);

    const terminal = page.locator('.terminal-container').first();
    await terminal.click();
    await page.keyboard.type('echo rt-e2e-marker');
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm')).toContainText('rt-e2e-marker', { timeout: 15_000 });

    // Second tab: the first shell must keep running.
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab').first().click();
    await expect(page.locator('.xterm')).toContainText('rt-e2e-marker', { timeout: 15_000 });
  });

  test('session manager renames and terminates with confirmation', async ({ page }) => {
    await page.getByLabel('Owner username').fill('sank');
    await page.getByLabel('Password').fill(process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'Rename' }).first().click();
    await page.getByLabel('New label').fill('renamed by test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.session-manager')).toContainText('renamed by test');
    await page.getByRole('button', { name: 'Terminate' }).first().click();
    await page.getByRole('button', { name: 'Terminate session' }).click();
    await expect(page.locator('.session-manager')).not.toContainText('renamed by test');
  });

  test('mobile layout keeps the special-key toolbar reachable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only');
    await page.getByLabel('Owner username').fill('sank');
    await page.getByLabel('Password').fill(process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('button', { name: 'Esc' })).toBeVisible();
    await page.getByRole('button', { name: 'Tab' }).tap();
    await expect(page.locator('.xterm')).toBeVisible();
  });

  test('logout clears the session', async ({ page }) => {
    await page.getByLabel('Owner username').fill('sank');
    await page.getByLabel('Password').fill(process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
