import { expect, test } from '@playwright/test';

test('shows URL and image intake together on desktop and stacks them without a drawer on mobile', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const intake = page.getByRole('region', { name: 'Add inspiration', exact: true });
  const web = intake.getByRole('region', { name: 'Capture a page', exact: true });
  const image = intake.getByRole('region', { name: 'Save an image', exact: true });
  await expect(web.getByLabel('Page URL', { exact: true })).toBeVisible();
  await expect(image.getByText('Drop an image here', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browser capture', exact: true })).toHaveCount(0);
  await expect(web.getByRole('button', { name: 'Capture URL', exact: true })).toBeDisabled();
  const left = await web.boundingBox(), right = await image.boundingBox();
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
  await intake.screenshot({ path: testInfo.outputPath('split-intake-desktop.png') });
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  for (const width of [768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(web.getByLabel('Page URL', { exact: true })).toBeVisible();
    await expect(image.getByRole('button', { name: 'browse files', exact: true })).toBeVisible();
    const top = await web.boundingBox(), bottom = await image.boundingBox();
    expect(top!.y + top!.height).toBeLessThanOrEqual(bottom!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await intake.screenshot({ path: testInfo.outputPath('split-intake-dark-mobile.png') });
  expect(errors).toEqual([]);
});

test('submits the visible URL field with Enter and keeps image drafts separate from URL capture', async ({ page }) => {
  await page.goto('/');
  const web = page.getByRole('region', { name: 'Capture a page', exact: true });
  const image = page.getByRole('region', { name: 'Save an image', exact: true });
  const url = web.getByLabel('Page URL', { exact: true });
  await expect(url).toBeEnabled();
  await image.getByLabel('Title / optional').fill('Keep my image draft');
  await image.getByLabel('Why I saved this / optional').fill('Image notes survive a URL capture');
  await url.fill('https://capture-fixture.example/keyboard');
  await web.getByLabel('Capture title', { exact: true }).fill('Keyboard URL specimen');
  await web.getByLabel('Capture note', { exact: true }).fill('Saved from the visible header field');
  await url.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Keyboard URL specimen', { timeout: 10_000 });
  await expect(dialog.getByLabel('Why you saved it')).toHaveValue('Saved from the visible header field');
  await dialog.getByRole('button', { name: 'Close reference', exact: true }).click();
  await expect(image.getByLabel('Title / optional')).toHaveValue('Keep my image draft');
  await expect(image.getByLabel('Why I saved this / optional')).toHaveValue('Image notes survive a URL capture');
  await expect(url).toHaveValue('');
  await expect(web.getByLabel('Capture title', { exact: true })).toHaveValue('');
  await web.locator('.capture-history > summary').click();
  await expect(web.getByText('Keyboard URL specimen', { exact: true })).toBeVisible();
});
