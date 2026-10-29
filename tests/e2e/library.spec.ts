import { expect, test } from '@playwright/test';
import { imageFixture } from '../helpers.js';

test('shows an honest empty library on desktop and mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What caught your eye today?' })).toBeVisible();
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('empty-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Add your first reference' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('empty-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('uploads, edits, copies, downloads, searches, and keeps a reference after reload', async ({ page }, testInfo) => {
  const bytes = await imageFixture();
  await page.goto('/');
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.getByLabel('Title / optional').fill('Purple specimen');
  await page.getByLabel('Why I saved this / optional').fill('A vivid purple accent');
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: bytes });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('#7C5CFF', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Saved locally. AI is optional/)).toBeVisible();
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
  await page.screenshot({ path: testInfo.outputPath('library-desktop.png'), fullPage: true });

  // Duplicate detection returns the saved item without replacing its edited title or note.
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'duplicate.png', mimeType: 'image/png', buffer: bytes });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Lavender dashboard');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('heading', { name: 'A closer look.' })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('detail-mobile.png'), fullPage: true });
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

test('offers only vision-capable Go models in both selectors and discloses Contributor privacy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  const readiness = page.getByLabel('AI activation requirements', { exact: true });
  await expect(readiness).toContainText('Your .env key is already loaded by the server.');
  await expect(readiness).toContainText('Approve image-sharing');
  await expect(page.getByLabel('Local monthly allowance guardrail')).toHaveCount(0);
  await expect(page.getByLabel(/Enable background AI/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'OpenCode Go account', exact: true })).toHaveAttribute('href', 'https://opencode.ai/console');
  const analyze = page.getByRole('combobox', { name: 'Analyze model', exact: true });
  const writer = page.getByRole('combobox', { name: 'Write-prompt model', exact: true });
  await expect(analyze.locator('option')).toHaveCount(24);
  const ids = await analyze.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(ids).toContain('deepseek-v4.1-flash');
  expect(ids).toContain('gemini-4-argon');
  expect(ids).toContain('gpt-6-luna');
  expect(ids).toContain('kimi-k3');
  for (const id of ['deepseek-v4-pro', 'deepseek-v4.1-flash-free', 'glm-5.2', 'beam-free', 'omen-alpha']) expect(ids).not.toContain(id);
  expect(await writer.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(ids);
  await analyze.selectOption('muse-spark-1.3-contributor');
  await expect(page.getByLabel(/I explicitly allow provider training/)).toBeVisible();
  await expect(page.getByLabel(/I explicitly allow provider training/)).not.toBeChecked();
  await expect(page.getByText(/Contributor tier: prompts and outputs may be used for model training/)).toBeVisible();
  const settings = await page.evaluate(async () => (await fetch('/api/ai')).json());
  expect(settings.settings).not.toHaveProperty('enabled');
  expect(settings.settings.allowImageSharing).toBe(false);
  expect(settings.settings.allowModelTraining).toBe(false);
});

test('reconnects an expired local browser session before saving AI settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OpenCode Go', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Write-prompt model', exact: true }).selectOption('deepseek-v4.1-flash');
  let rejectedRequests = 0;
  let refreshedSessions = 0;
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() === 401) rejectedRequests++;
    if (response.url().endsWith('/api/session') && response.status() === 200) refreshedSessions++;
  });
  await page.context().addCookies([{ name: 'design_index_session', value: 'expired-test-session', domain: '127.0.0.1', path: '/api', httpOnly: true, sameSite: 'Strict' }]);
  await page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
  await expect(page.getByText('AI settings saved.', { exact: true })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/ai')).json());
  expect(status.settings.promptModel).toBe('deepseek-v4.1-flash');
  expect(status.settings).not.toHaveProperty('monthlyBudgetUsd');
  expect(status.settings.allowImageSharing).toBe(false);
  expect(rejectedRequests).toBeGreaterThan(0);
  expect(refreshedSessions).toBeGreaterThan(0);
});

test('automatically starts Go with sharing consent, reviews labels, and copies only saved prompt revisions', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('On your machine')).toBeVisible();
  await page.getByLabel('Title / optional').fill('AI specimen');
  await page.getByLabel('Choose reference image').setInputFiles({ name: 'ai-specimen.png', mimeType: 'image/png', buffer: await imageFixture('#5E8B6F') });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close reference' }).click();
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OpenCode Go', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Analyze model', exact: true }).selectOption('deepseek-v4.1-flash');
  await page.getByRole('combobox', { name: 'Write-prompt model', exact: true }).selectOption('gemini-4-argon');
  await page.getByLabel(/I allow normalized screenshots/).check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('AI settings saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open AI specimen', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copy prompt', exact: true })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Reject minimal', exact: true }).click();
  await dialog.getByLabel('Manual label value').selectOption('editorial');
  await dialog.getByRole('button', { name: 'Add label', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Accept editorial' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Edit prompt', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Design-language prompt', exact: true }).fill('Personal refined prompt with a quiet palette.');
  await dialog.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('Personal refined prompt');
  await dialog.getByRole('button', { name: 'Save prompt revision', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('New prompt revision saved.');
  await dialog.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Personal refined prompt with a quiet palette.');
  await dialog.getByRole('button', { name: 'Close reference' }).click();

  await page.getByRole('combobox', { name: 'Filter label', exact: true }).selectOption('editorial');
  await expect(page.getByRole('button', { name: 'Open AI specimen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Lavender dashboard', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear label filter' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('go-settings-mobile.png'), fullPage: true });
  await page.getByLabel(/I allow normalized screenshots/).uncheck();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
});
