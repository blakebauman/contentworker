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

  // Author a new entry. Saving stays in the editor (the URL swaps to the
  // created entry) and the header picks up the entry's status and version.
  await page.getByRole('button', { name: '+ New entry' }).click();
  const title = `E2E ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title); // localized "title" field
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // Publish from the editor header: save-then-confirm with a summary dialog.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish entry' }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Back on the list, the entry shows as published.
  await page.getByRole('link', { name: /Article/ }).click();
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(row.getByText('published')).toBeVisible();
});

test('authors rich text with marks and persists it across a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();
  await page.getByRole('button', { name: '+ New entry' }).click();

  const title = `Rich ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);

  // Type into the Tiptap editor, then bold the word "bolded". Right after
  // typing, ProseMirror may still be digesting the input; when it catches up,
  // its view update re-asserts the caret and can wipe a selection made in the
  // gap. Mimic a real user watching the highlight: keep extending until the
  // selection actually covers the word, then act on it.
  const editor = page.locator('.rich-text-editor');
  const selectLeft = async (word: string) => {
    const read = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
    for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    const deadline = Date.now() + 8000;
    let stable = 0;
    while (Date.now() < deadline) {
      const sel = await read();
      if (sel === word) {
        // ProseMirror stomps un-ingested DOM selections on its next flush, so a
        // selection that HOLDS across consecutive reads is one it has accepted.
        stable += 1;
        if (stable >= 2) return;
        await page.waitForTimeout(75);
        continue;
      }
      stable = 0;
      if (sel.length < word.length && word.endsWith(sel)) {
        await page.keyboard.press('Shift+ArrowLeft');
      } else {
        await page.waitForTimeout(50);
      }
    }
    expect(await read()).toBe(word);
  };
  await editor.click();
  await page.keyboard.type('Plain then bolded');
  await selectLeft('bolded');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('bolded');

  // Append a word and link it to another entry (created by the previous test).
  // Typing at the end of bold text inherits the mark, so toggle it off first.
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.type(' linkme');
  await expect(editor.locator('strong')).toHaveText('bolded');
  await selectLeft('linkme');
  await page.getByRole('button', { name: 'Link to entry' }).click();
  await page.getByRole('combobox', { name: 'Pick a target' }).click();
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(editor.locator('span[data-mark="entryLink"]')).toHaveText('linkme');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();

  // Reopen the entry from the list: the stored document round-trips back.
  await page.getByRole('link', { name: /Article/ }).click();
  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.locator('.rich-text-editor');
  await expect(reopened).toContainText('Plain then bolded');
  await expect(reopened.locator('strong')).toHaveText('bolded');
  await expect(reopened.locator('span[data-mark="entryLink"]')).toHaveText('linkme');
});

test('publishing with unsaved edits saves first, then confirms', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();

  // Create a draft, then edit WITHOUT saving.
  await page.getByRole('button', { name: '+ New entry' }).click();
  const title = `Chain ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await page.getByRole('textbox', { name: /Title/ }).fill(`${title} v2`);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  // Publish while dirty: the save happens first, then the confirm dialog.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await page.getByRole('button', { name: 'Publish entry' }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Publish with an INVALID form: feedback at the button, no dialog.
  await page.getByRole('textbox', { name: /Title/ }).fill('');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Fix 1 field error to publish')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish entry' })).not.toBeVisible();
});

test('navigating away from unsaved edits asks before discarding', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();
  await page.getByRole('button', { name: '+ New entry' }).click();
  await page.getByRole('textbox', { name: /Title/ }).fill(`Guard ${Date.now()}`);

  // Keep editing: the dialog closes and the editor stays.
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: /Title/ })).toBeVisible();

  // Discard: navigation proceeds.
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('bulk unpublish confirms once and surfaces per-entry failures by title', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Content' }).click();
  await page.getByRole('link', { name: /Article/ }).click();

  // Two fresh drafts (unpublishing a draft fails server-side — the failure path).
  const stamp = Date.now();
  for (const n of [1, 2]) {
    await page.getByRole('button', { name: '+ New entry' }).click();
    await page.getByRole('textbox', { name: /Title/ }).fill(`Bulk ${stamp} ${n}`);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Entry created')).toBeVisible();
    await page.getByRole('link', { name: /Article/ }).click();
  }

  // Select both rows and unpublish through the confirm dialog.
  for (const n of [1, 2]) {
    await page
      .getByRole('row', { name: new RegExp(`Bulk ${stamp} ${n}`) })
      .getByRole('checkbox')
      .check();
  }
  await page.getByRole('button', { name: 'Unpublish selected' }).click();
  await expect(page.getByText('Unpublish 2 entries?')).toBeVisible();
  await page.getByRole('button', { name: 'Unpublish entries' }).click();

  // Both drafts fail; the alert names each entry, not just a count.
  const failures = page.getByRole('alert').filter({ hasText: 'entries failed' });
  await expect(failures).toBeVisible();
  await expect(failures.getByText(`Bulk ${stamp} 1`)).toBeVisible();
  await expect(failures.getByText(`Bulk ${stamp} 2`)).toBeVisible();
  await failures.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('2 entries failed')).not.toBeVisible();
});

test('navigates to settings and lists the seeded dev API keys', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  // The three seeded dev keys (cma/cda/cpa) render as kind badges.
  await expect(page.getByText('CMA', { exact: true })).toBeVisible();
});
