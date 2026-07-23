import {
  createContentType,
  createEntry,
  getContentType,
  listPreviewEntries,
  publishContentType,
  publishEntry,
  setEntryMetadata,
  updateEntry,
} from '@cw/application';
import type { ContentTypeDraft, EntryFields } from '@cw/domain';
import { logger } from '@cw/telemetry';
import type { SeedRun } from './types.js';

/** Deterministic pick — the seed never uses Math.random so demos reproduce. */
export function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

export const WORDS = {
  adjectives: [
    'Practical',
    'Modern',
    'Essential',
    'Advanced',
    'Complete',
    'Effortless',
    'Scalable',
  ],
  topics: [
    'content modeling',
    'localization',
    'publishing pipelines',
    'edge delivery',
    'agent workflows',
    'structured content',
    'preview environments',
    'release management',
    'semantic search',
    'API design',
    'multi-tenancy',
  ],
  verbs: ['Mastering', 'Understanding', 'Exploring', 'Rethinking', 'Debugging'],
} as const;

export function localized(
  defaultLocale: string,
  value: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { [defaultLocale]: value };
  if (extra) {
    for (const [loc, v] of Object.entries(extra)) out[loc] = v;
  }
  return out;
}

export const entryLink = (id: string) => ({ id, linkType: 'Entry' as const });
export const assetLink = (id: string) => ({ id, linkType: 'Asset' as const });

/** A minimal rich-text document: one paragraph of plain text. */
export function richTextDoc(text: string) {
  return {
    nodeType: 'document' as const,
    content: [
      {
        nodeType: 'paragraph' as const,
        content: [{ nodeType: 'text' as const, value: text, marks: [] as const }],
      },
    ],
  };
}

const text = (value: string, marks: readonly { type: string }[] = []) => ({
  nodeType: 'text',
  value,
  marks,
});
const paragraph = (...content: unknown[]) => ({ nodeType: 'paragraph', content });

/**
 * One document exercising every node the admin's rich-text mapper supports:
 * headings 1–6, both list kinds, blockquote, code block, hr, all five marks,
 * plain/entry/asset hyperlinks, and embedded entry/asset blocks — so the
 * editor's full round-trip renders against seeded content.
 */
export function richTextKitchenSink(embeddedEntryId: string, embeddedAssetId: string) {
  const heading = (level: number) => ({
    nodeType: `heading-${level}`,
    content: [text(`Heading level ${level}`)],
  });
  return {
    nodeType: 'document',
    content: [
      ...[1, 2, 3, 4, 5, 6].map(heading),
      paragraph(
        text('Marks: '),
        text('bold', [{ type: 'bold' }]),
        text(', '),
        text('italic', [{ type: 'italic' }]),
        text(', '),
        text('underline', [{ type: 'underline' }]),
        text(', '),
        text('code', [{ type: 'code' }]),
        text(', '),
        text('strikethrough', [{ type: 'strikethrough' }]),
        text('.'),
      ),
      {
        nodeType: 'unordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('First bullet'))] },
          { nodeType: 'list-item', content: [paragraph(text('Second bullet'))] },
        ],
      },
      {
        nodeType: 'ordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('Step one'))] },
          { nodeType: 'list-item', content: [paragraph(text('Step two'))] },
        ],
      },
      { nodeType: 'blockquote', content: [paragraph(text('Structured content is a graph.'))] },
      {
        nodeType: 'code-block',
        data: { language: 'ts' },
        content: [text("const entry = await client.getEntry('id');")],
      },
      { nodeType: 'hr', content: [] },
      paragraph(
        text('A '),
        {
          nodeType: 'hyperlink',
          data: { uri: 'https://example.com/docs' },
          content: [text('plain link')],
        },
        text(', an '),
        {
          nodeType: 'entry-hyperlink',
          data: { target: entryLink(embeddedEntryId) },
          content: [text('entry link')],
        },
        text(', and an '),
        {
          nodeType: 'asset-hyperlink',
          data: { target: assetLink(embeddedAssetId) },
          content: [text('asset link')],
        },
        text('.'),
      ),
      { nodeType: 'embedded-entry-block', data: { target: entryLink(embeddedEntryId) } },
      { nodeType: 'embedded-asset-block', data: { target: assetLink(embeddedAssetId) } },
    ],
  };
}

export async function ensureContentType(run: SeedRun, draft: ContentTypeDraft): Promise<void> {
  const existed = await contentTypeExists(run, draft.apiId);
  await createContentType(run.ctx, run.scope, draft);
  await publishContentType(run.ctx, run.scope, draft.apiId);
  if (!existed) {
    logger.info({ apiId: draft.apiId }, 'seed: created content type');
  }
}

async function contentTypeExists(run: SeedRun, apiId: string): Promise<boolean> {
  try {
    await getContentType(run.ctx, run.scope, apiId);
    return true;
  } catch {
    return false;
  }
}

export async function findEntryByField(
  run: SeedRun,
  contentTypeApiId: string,
  field: string,
  value: string,
): Promise<string | null> {
  const rows = await listPreviewEntries(run.ctx, run.scope, {
    contentTypeApiId,
    filters: [{ field, op: 'eq', value }],
    locale: run.locale,
    limit: 1,
  });
  return rows[0]?.id ?? null;
}

export async function ensurePublishedEntry(
  run: SeedRun,
  contentTypeApiId: string,
  matchField: string,
  matchValue: string,
  fields: EntryFields,
): Promise<{ id: string; created: boolean }> {
  const existing = await findEntryByField(run, contentTypeApiId, matchField, matchValue);
  if (existing) return { id: existing, created: false };

  const view = await createEntry(run.ctx, run.scope, { contentTypeApiId, fields });
  await publishEntry(run.ctx, run.scope, view.entry.id);
  return { id: view.entry.id, created: true };
}

/** One generated entry: its identity, fields, and desired lifecycle state. */
export interface GeneratedEntry {
  /** Value of `matchField` in the default locale — must be unique per type. */
  readonly matchValue: string;
  readonly fields: EntryFields;
  /** draft = never published; changed = published then edited (diff view data). */
  readonly status: 'draft' | 'published' | 'changed';
  /** Applied before publish so it lands in the published snapshot. */
  readonly metadata?: { tags?: readonly string[]; concepts?: readonly string[] };
  /** For status 'changed': a field patch saved as a new draft after publish. */
  readonly patch?: EntryFields;
}

/**
 * Seeds `count` deterministic entries of one content type, skipping cheaply
 * when a previous run already completed the block (probe the last title: one
 * query). A partially-seeded block (first exists, last missing — a crashed
 * earlier run) falls back to per-entry existence checks so reruns never
 * duplicate. Returns the ids of all `count` entries, in index order.
 */
export async function seedGeneratedEntries(
  run: SeedRun,
  contentTypeApiId: string,
  matchField: string,
  count: number,
  make: (i: number) => GeneratedEntry,
): Promise<string[]> {
  const { ctx, scope } = run;
  if (count === 0) return [];

  const lastId = await findEntryByField(
    run,
    contentTypeApiId,
    matchField,
    make(count - 1).matchValue,
  );
  if (lastId) {
    // Block complete — collect the ids without touching anything.
    const rows = await listPreviewEntries(ctx, scope, {
      contentTypeApiId,
      locale: run.locale,
      limit: count + 50,
    });
    const byValue = new Map(
      rows.map((r) => [
        String((r.fields[matchField] as Record<string, unknown>)?.[run.locale]),
        r.id,
      ]),
    );
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = byValue.get(make(i).matchValue);
      if (id) ids.push(id);
    }
    return ids;
  }
  const partial =
    (await findEntryByField(run, contentTypeApiId, matchField, make(0).matchValue)) !== null;

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const gen = make(i);
    if (partial) {
      const existing = await findEntryByField(run, contentTypeApiId, matchField, gen.matchValue);
      if (existing) {
        ids.push(existing);
        continue;
      }
    }
    const view = await createEntry(ctx, scope, { contentTypeApiId, fields: gen.fields });
    const id = view.entry.id;
    if (gen.metadata) await setEntryMetadata(ctx, scope, id, gen.metadata);
    if (gen.status !== 'draft') {
      await publishEntry(ctx, scope, id);
      if (gen.status === 'changed' && gen.patch) {
        await updateEntry(ctx, scope, id, { ...gen.fields, ...gen.patch });
      }
    }
    ids.push(id);
  }
  logger.info({ contentTypeApiId, count }, 'seed: generated entries');
  return ids;
}

/** Standard status mix by index: every 5th draft, else every 7th changed. */
export function statusFor(i: number): GeneratedEntry['status'] {
  if (i % 5 === 0) return 'draft';
  if (i % 7 === 0) return 'changed';
  return 'published';
}

/** Backdates `daysAgo` days (plus a deterministic time of day) off the clock. */
export function backdated(now: Date, daysAgo: number, hour: number, minute = 15): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
