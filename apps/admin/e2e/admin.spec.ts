import { expect, test } from '@playwright/test';

// Run the admin same-origin: an empty baseUrl makes the client issue relative
// requests, which vite preview proxies to the API (see vite.config.ts).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cw-admin-connection', JSON.stringify({ baseUrl: '' }));
  });
});

test('authors and publishes an entry end-to-end', async ({ page }) => {
  await page.goto('/');

  // Open the Content section, then pick the seeded content type from its sub-nav.
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();

  // Author a new entry.
  await page.getByRole('button', { name: '+ New entry' }).click();
  const title = `E2E ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title); // localized "title" field
  await page.getByRole('button', { name: 'Save draft' }).click();

  // Success toast + the row shows up as a draft.
  await expect(page.getByText('Entry created')).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(row.getByText('draft')).toBeVisible();

  // Publish that row; optimistic update flips the badge and a toast confirms.
  await row.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Entry published')).toBeVisible();
  await expect(row.getByText('published')).toBeVisible();
});

test('authors rich text with marks and persists it across a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();
  await page.getByRole('button', { name: '+ New entry' }).click();

  const title = `Rich ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);

  // Type into the Tiptap editor, then bold the word "bolded".
  const editor = page.locator('.rich-text-editor');
  await editor.click();
  await page.keyboard.type('Plain then bolded');
  for (let i = 0; i < 'bolded'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('bolded');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();

  // Reopen the entry: the stored document round-trips back into the editor.
  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.locator('.rich-text-editor');
  await expect(reopened).toContainText('Plain then bolded');
  await expect(reopened.locator('strong')).toHaveText('bolded');
});

test('navigates to settings and lists the seeded dev API keys', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  // The three seeded dev keys (cma/cda/cpa) render as kind badges.
  await expect(page.getByText('CMA', { exact: true })).toBeVisible();
});
