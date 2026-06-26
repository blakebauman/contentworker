import { describe, expect, it } from 'vitest';
import {
  type RichTextDocument,
  defineContentType,
  extractReferences,
  extractRichTextTargets,
  isRichTextDocument,
  validateEntryFields,
  validateRichText,
} from '../src/index.js';

const ctx = { defaultLocale: 'en-US', locales: ['en-US'] };

const doc = (content: RichTextDocument['content']): RichTextDocument => ({
  nodeType: 'document',
  content,
});

const paragraph = (text: string) => ({
  nodeType: 'paragraph',
  content: [{ nodeType: 'text', value: text, marks: [{ type: 'bold' }] }],
});

const embeddedEntry = (id: string) => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' as const } },
  content: [],
});

describe('rich text document', () => {
  it('recognises a well-formed document', () => {
    expect(isRichTextDocument(doc([paragraph('hi')]))).toBe(true);
    expect(isRichTextDocument({ nodeType: 'paragraph' })).toBe(false);
    expect(isRichTextDocument('not a doc')).toBe(false);
  });

  it('validates node structure and reference targets', () => {
    expect(validateRichText(doc([paragraph('ok')]))).toEqual([]);
    // A text node without a string value is invalid.
    expect(
      validateRichText(doc([{ nodeType: 'paragraph', content: [{ nodeType: 'text' }] }])),
    ).not.toEqual([]);
    // A reference node missing its target is invalid.
    expect(validateRichText(doc([{ nodeType: 'embedded-entry-block' }]))).not.toEqual([]);
  });

  it('extracts embedded entry/asset targets (deep)', () => {
    const value = doc([
      paragraph('intro'),
      {
        nodeType: 'blockquote',
        content: [
          embeddedEntry('e2'),
          {
            nodeType: 'asset-hyperlink',
            data: { target: { id: 'a1', linkType: 'Asset' } },
            content: [],
          },
        ],
      },
    ]);
    expect(extractRichTextTargets(value)).toEqual([
      { id: 'e2', linkType: 'Entry' },
      { id: 'a1', linkType: 'Asset' },
    ]);
  });
});

describe('rich text in the content model', () => {
  const article = defineContentType({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });

  it('rejects an invalid rich-text field value', () => {
    const issues = validateEntryFields(
      article,
      { title: { 'en-US': 'T' }, body: { 'en-US': { nodeType: 'paragraph' } } },
      ctx,
    );
    expect(issues.some((i) => i.field === 'body')).toBe(true);
  });

  it('extracts references embedded in a rich-text body', () => {
    const edges = extractReferences(
      'e1',
      { title: { 'en-US': 'T' }, body: { 'en-US': doc([embeddedEntry('e2')]) } },
      article,
    );
    expect(edges).toEqual([{ fromEntryId: 'e1', fromField: 'body', toId: 'e2', toType: 'Entry' }]);
  });
});
