import { expect, test } from '@playwright/test';
import { imageFixture } from '../helpers.js';

test.use({ colorScheme: 'light' });

test('follows system appearance until a manual override is chosen', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Use system theme', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('design-index-theme'))).toBeNull();
});

test('remembers manual choices across reloads and can return to Auto', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('design-index-theme'))).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Use system theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('design-index-theme'))).toBeNull();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('applies a stored dark preference before the application bundle runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('design-index-theme', 'dark'));
  await page.route('**/assets/*.js', (route) => route.abort());
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark');
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#121814');
  expect(await page.locator('#root').textContent()).toBe('');
});

test('keeps theme changes usable when local storage is blocked', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(errors).toEqual([]);
});

test('synchronizes manual theme preferences across tabs', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await other.getByRole('button', { name: 'Use system theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
  await other.close();
});

test('themes settings and mobile details without changing reference colors', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'OpenCode Go', exact: true });
  await expect(settings).toBeVisible();
  expect(await settings.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(29, 41, 32)');
  expect(await page.getByRole('combobox', { name: 'Analyze model', exact: true }).evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark');
  await page.screenshot({ path: testInfo.outputPath('dark-settings-desktop.png'), fullPage: true });

  await page.getByLabel('Title / optional').fill('Dark mode reference');
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'dark-mode-reference.png', mimeType: 'image/png', buffer: await imageFixture('#3A6B91') });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('#3A6B91', { exact: true })).toBeVisible();
  expect(await dialog.locator('.color-block').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(58, 107, 145)');
  expect(await dialog.locator('img').evaluate((element) => getComputedStyle(element).filter)).toBe('none');
  expect(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(18, 24, 20)');
  await dialog.getByRole('button', { name: 'Copy CSS', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('#3A6B91');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dark-detail-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close reference', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
