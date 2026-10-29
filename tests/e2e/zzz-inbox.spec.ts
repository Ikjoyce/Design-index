import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { imageFixture } from '../helpers.js';

function assertIsolated(directory: string) {
  const inside = relative(join(tmpdir(), 'opencode'), directory);
  expect(isAbsolute(inside)).toBe(false); expect(inside.startsWith('..')).toBe(false);
  expect(inside).toContain('design-index-e2e-');
}

test('picks up dropped images without a reload while AI is paused, reports bad files, and deduplicates', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Folder inbox', exact: true }); await expect(panel).toBeVisible();
  await panel.locator('summary').click();
  const state = await page.evaluate(async () => (await fetch('/api/inbox')).json());
  expect(state.enabled).toBe(true); assertIsolated(state.directory);
  const before = await page.evaluate(async () => (await fetch('/api/ai')).json()); expect(before.settings.allowImageSharing).toBe(false);
  const bytes = await imageFixture('#91527C');
  await writeFile(join(state.directory, 'Folder-only specimen.png'), bytes);
  await expect(page.getByRole('button', { name: 'Open Folder-only specimen', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(/Image sharing is not approved. Images still import locally/)).toBeVisible();
  await writeFile(join(state.directory, 'Duplicate folder specimen.png'), bytes);
  await expect(panel.getByText('imported · already in library', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Open Folder-only specimen', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open Duplicate folder specimen', exact: true })).toHaveCount(0);
  await writeFile(join(state.directory, 'Broken folder specimen.png'), 'Not a valid image');
  await expect(panel.getByText('Choose a PNG, JPEG, or WebP image.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Retry failed imports', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Copy inbox path', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(state.directory);
  const after = await page.evaluate(async () => (await fetch('/api/ai')).json()); expect(after.usage.calls).toBe(before.usage.calls);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('folder-inbox-dark-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('automatically analyzes new folder imports and generates a saved prompt with consent and no allowance/enable step', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Folder inbox', exact: true })).toBeVisible();
  const state = await page.evaluate(async () => (await fetch('/api/inbox')).json()); assertIsolated(state.directory);
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await page.getByLabel(/I allow normalized screenshots/).check();
  await expect(page.getByLabel(/Enable background AI/)).toHaveCount(0);
  await expect(page.getByLabel('Local monthly allowance guardrail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
  await expect(page.getByText('AI settings saved.', { exact: true })).toBeVisible();
  await writeFile(join(state.directory, 'Automatic folder agents.png'), await imageFixture('#24597B'));
  await page.getByRole('button', { name: 'Open Automatic folder agents', exact: true }).click({ timeout: 15_000 });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Copy prompt', exact: true })).toBeVisible({ timeout: 15_000 });
  const body = await dialog.getByRole('textbox', { name: 'Design-language prompt', exact: true }).inputValue(); expect(body).toContain('## Tokens');
  await dialog.getByRole('button', { name: 'Close reference', exact: true }).click();
  await page.getByLabel(/I allow normalized screenshots/).uncheck(); await page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
});
