import { expect, test } from '@playwright/test';
import { imageFixture } from '../helpers.js';

test('shows an honest empty library on desktop and mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What caught your eye today?' })).toBeVisible();
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Add your first reference' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/empty-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('uploads, edits, copies, downloads, searches, and keeps a reference after reload', async ({ page }) => {
  const bytes = await imageFixture();
  await page.goto('/');
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.getByLabel('Title / optional').fill('Purple specimen');
  await page.getByLabel('Why I saved this / optional').fill('A vivid purple accent');
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: bytes });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('#7C5CFF', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Saved locally. AI comes next.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy CSS' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Palette CSS copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('--color-1: #7C5CFF');

  await dialog.getByLabel('Title', { exact: true }).fill('Lavender dashboard');
  await dialog.getByLabel('Why you saved it').fill('Soft geometry and generous spacing');
  await dialog.getByRole('button', { name: 'Save notes' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Your notes are saved.');
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('link', { name: /Download untouched original/ }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);

  await dialog.getByRole('button', { name: 'Close reference' }).click();
  await expect(page.getByRole('button', { name: 'Open Lavender dashboard' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Lavender dashboard' })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search references by title or note' });
  await search.fill('missing');
  await expect(page.getByRole('heading', { name: 'Nothing matches this search.' })).toBeVisible();
  await search.fill('generous');
  await expect(page.getByRole('button', { name: 'Open Lavender dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.screenshot({ path: 'test-results/library-desktop.png', fullPage: true });

  // Duplicate detection returns the saved item without replacing its edited title or note.
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'duplicate.png', mimeType: 'image/png', buffer: bytes });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Lavender dashboard');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('heading', { name: 'A closer look.' })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/detail-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Lavender dashboard' })).toHaveCount(1);
});

test('supports drag/drop and image paste without losing the reference note', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.getByLabel('Why I saved this / optional').fill('Saved through drag and drop');
  const dropped = (await imageFixture('#285B49')).toString('base64');
  await page.locator('.capture-panel').evaluate((element, encoded) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], 'Dropped reference.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, dropped);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Why you saved it')).toHaveValue('Saved through drag and drop');
  await dialog.getByRole('button', { name: 'Close reference' }).click();

  const pasted = (await imageFixture('#F1E8D5')).toString('base64');
  await page.evaluate((encoded) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], 'Pasted reference.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Pasted reference');
  await expect(dialog.getByText('#F1E8D5', { exact: true })).toBeVisible();
});
