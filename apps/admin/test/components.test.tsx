// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@cw/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '../src/components/EntryForm.js';
import { ToastProvider, useToast } from '../src/lib/toast.js';

afterEach(cleanup);

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const contentType: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', localized: true, position: 0 }),
    field({ apiId: 'slug', name: 'Slug', localized: false, position: 1 }),
  ],
};

describe('EntryForm localization tabs', () => {
  it('edits a localized field per locale and a non-localized field once', () => {
    const onSave = vi.fn();
    render(
      <EntryForm
        contentType={contentType}
        initial={{}}
        locales={['en-US', 'de-DE']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    // Default (en-US) tab: both title and slug are editable.
    let textboxes = screen.getAllByRole('textbox');
    expect(textboxes).toHaveLength(2);
    fireEvent.change(textboxes[0]!, { target: { value: 'Hello' } }); // title (en-US)
    fireEvent.change(textboxes[1]!, { target: { value: 'hello' } }); // slug (default only)

    // Switch to de-DE: only the localized field shows; slug is hidden.
    fireEvent.click(screen.getByRole('button', { name: 'de-DE' }));
    textboxes = screen.getAllByRole('textbox');
    expect(textboxes).toHaveLength(1);
    fireEvent.change(textboxes[0]!, { target: { value: 'Hallo' } }); // title (de-DE)

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledWith({
      title: { 'en-US': 'Hello', 'de-DE': 'Hallo' },
      slug: { 'en-US': 'hello' },
    });
  });
});

describe('EntryForm validation and fallbacks', () => {
  it('shows a validation error for a required field on save', () => {
    const requiredType: ContentType = {
      ...contentType,
      fields: [field({ apiId: 'title', name: 'Title', localized: true, required: true })],
    };
    const onSave = vi.fn();
    render(
      <EntryForm
        contentType={requiredType}
        initial={{}}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Field is required')).not.toBeNull();
  });

  it('shows a fallback hint when a locale inherits from the default', () => {
    const onSave = vi.fn();
    render(
      <EntryForm
        contentType={contentType}
        initial={{ title: { 'en-US': 'Hello' } }}
        locales={['en-US', 'de-DE']}
        defaultLocale="en-US"
        fallbacks={{ 'de-DE': 'en-US' }}
        pickers={{ entries: [], assets: [] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'de-DE' }));
    expect(screen.getByText(/Falls back to en-US: Hello/)).not.toBeNull();
  });
});

describe('EntryForm rich text', () => {
  // Interaction coverage (typing, toolbar, embeds) lives in the Playwright e2e
  // suite — ProseMirror selection/input is unreliable under jsdom.
  it('mounts the Tiptap editor and renders an existing document', () => {
    const richType: ContentType = {
      ...contentType,
      fields: [field({ apiId: 'body', name: 'Body', type: 'RichText' })],
    };
    render(
      <EntryForm
        contentType={richType}
        initial={{
          body: {
            'en-US': {
              nodeType: 'document',
              content: [
                {
                  nodeType: 'heading-1',
                  content: [{ nodeType: 'text', value: 'Stored title', marks: [] }],
                },
                {
                  nodeType: 'paragraph',
                  content: [{ nodeType: 'text', value: 'Stored body text', marks: [] }],
                },
              ],
            },
          },
        }}
        locales={['en-US']}
        defaultLocale="en-US"
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Stored title')).not.toBeNull();
    expect(screen.getByText('Stored body text')).not.toBeNull();
    // Formatting toolbar is present.
    expect(screen.getByRole('button', { name: 'Bold' })).not.toBeNull();
  });
});

describe('toasts', () => {
  function Probe() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.success('Saved!')}>
        go
      </button>
    );
  }

  it('renders a toast message when pushed', () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    expect(screen.queryByText('Saved!')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('Saved!')).not.toBeNull();
  });
});
