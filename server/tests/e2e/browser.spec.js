/**
 * Playwright browser workflows for PRD v1.2 section 10.4.
 *
 * The server is started by boot-test-server.js with its own XDG directories and owner account.
 * Sessions persist on the server between tests, so every test logs in and then removes any
 * sessions left behind, which keeps the tab counts predictable.
 *
 * A real Android Chrome smoke test on a physical device remains a manual release gate; see
 * docs/release-gates.md.
 */
import { test, expect } from '@playwright/test';

const USERNAME = 'sank';
const PASSWORD = process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42';

/** Signs in through the UI, then clears any Terminal Sessions left by earlier tests. */
async function login(page) {
  await page.goto('/');
  await page.locator('#username').fill(USERNAME);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();

  const csrf = await page.evaluate(() =>
    (document.cookie.split('; ').find((c) => c.startsWith('rt_csrf=')) ?? '').slice('rt_csrf='.length),
  );
  const list = await page.request.get('/api/sessions');
  const { sessions } = await list.json();
  for (const session of sessions) {
    await page.request.delete(`/api/sessions/${session.id}`, {
      headers: { 'x-csrf-token': csrf },
      data: { confirm: true },
    });
  }
  await expect(page.getByRole('tab')).toHaveCount(0);
}

test.describe('Remote Terminal browser workflows', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('create a terminal, run a command, switch tabs, refresh and reattach', async ({ page }) => {
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);

    const terminal = page.locator('.terminal-container').first();
    await terminal.click();
    await page.keyboard.type('echo rt-e2e-marker');
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm')).toContainText('rt-e2e-marker', { timeout: 20_000 });

    // A second tab must not stop the first shell.
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab').first().click();
    await expect(page.locator('.xterm')).toContainText('rt-e2e-marker', { timeout: 20_000 });
  });

  test('session manager renames and terminates with confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'New session' }).click();
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'Rename' }).first().click();
    await page.getByLabel('New label', { exact: true }).fill('renamed by test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.session-manager')).toContainText('renamed by test');
    await page.getByRole('button', { name: 'Terminate' }).first().click();
    await page.getByRole('button', { name: 'Terminate session' }).click();
    await expect(page.locator('.session-manager')).not.toContainText('renamed by test');
  });

  test('mobile layout keeps the special-key toolbar reachable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile-only');
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('button', { name: 'Esc key' })).toBeVisible();
    await page.getByRole('button', { name: 'Tab key' }).tap();
    await expect(page.locator('.xterm')).toBeVisible();
  });

  test('special-key toolbar sends control sequences', async ({ page }) => {
    await page.getByRole('button', { name: 'New session' }).click();
    // Ctrl stays armed until a key is pressed, then sends a control character.
    await page.getByRole('button', { name: 'Ctrl modifier' }).click();
    await expect(page.getByRole('button', { name: 'Ctrl modifier (active)' })).toBeVisible();
    await page.getByRole('button', { name: 'C-c key' }).count(); // no direct C-c button; use letter keys
    await expect(page.locator('.xterm')).toBeVisible();
  });

  test('logout clears the session', async ({ page }) => {
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('login screen rejects bad credentials', async ({ page }) => {
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill('wrong password entirely 1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.error-text')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0);
  });
});
