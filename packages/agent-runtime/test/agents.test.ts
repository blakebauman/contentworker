import { type AppContext, createContentType, createEntry, createSpace } from '@cw/application';
import type { GenerateRequest } from '@cw/ports';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { InProcessAgentRuntime, makeActivities } from '../src/index.js';

const scope = { spaceId: 'blog', environmentId: 'master' };

async function seed(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'post',
    name: 'Post',
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
        apiId: 'summary',
        name: 'Summary',
        type: 'Text',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'seoDescription',
        name: 'SEO description',
        type: 'Text',
        localized: false,
        required: false,
        position: 2,
      },
    ],
  });
  const entry = await createEntry(ctx, scope, {
    contentTypeApiId: 'post',
    fields: { title: { 'en-US': 'Postgres indexing tips' } },
  });
  return entry.entry.id;
}

function makeCtx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
  };
}

describe('P8: durable agents (in-process executor)', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('enrich fills empty fields and applies them when autoApply=true', async () => {
    const id = await seed(ctx);
    // Model returns values for both empty fields (summary, seoDescription).
    const ai = new StubAIProvider(() => ({
      summary: 'A guide to PG indexes.',
      seoDescription: 'Speed up Postgres queries.',
    }));
    const runtime = new InProcessAgentRuntime(makeActivities({ ctx, ai }));

    const result = await runtime.run('enrich', { scope, entryId: id, autoApply: true });
    expect(result.status).toBe('completed');
    expect(result.decisions[0]).toContain('summary');

    // The enriched values were applied as a new draft version.
    const got = await ctx.store.entries.get(scope, id);
    expect(got?.fields.summary?.['en-US']).toBe('A guide to PG indexes.');
    expect(got?.entry.currentVersion).toBe(2);
    // Title (display field) was left untouched.
    expect(got?.fields.title?.['en-US']).toBe('Postgres indexing tips');
  });

  it('routes to human review when autoApply=false (HITL) without modifying the entry', async () => {
    const id = await seed(ctx);
    const ai = new StubAIProvider(() => ({ summary: 'x', seoDescription: 'y' }));
    const runtime = new InProcessAgentRuntime(makeActivities({ ctx, ai }));

    const result = await runtime.run('enrich', { scope, entryId: id, autoApply: false });
    expect(result.status).toBe('needs_review');
    expect(result.proposed?.summary?.['en-US']).toBe('x');
    // Entry unchanged (still version 1).
    expect((await ctx.store.entries.get(scope, id))?.entry.currentVersion).toBe(1);
  });

  it('routes to review on low confidence (model filled only some fields)', async () => {
    const id = await seed(ctx);
    const ai = new StubAIProvider(() => ({ summary: 'only one' })); // seoDescription missing
    const runtime = new InProcessAgentRuntime(makeActivities({ ctx, ai }));
    const result = await runtime.run('enrich', { scope, entryId: id, autoApply: true });
    expect(result.status).toBe('needs_review');
    expect(result.decisions).toContain('low confidence');
  });

  it('skips when there are no empty fields', async () => {
    const id = await seed(ctx);
    const ai = new StubAIProvider(() => ({ summary: 's', seoDescription: 'd' }));
    const runtime = new InProcessAgentRuntime(makeActivities({ ctx, ai }));
    await runtime.run('enrich', { scope, entryId: id, autoApply: true }); // fills them
    const second = await runtime.run('enrich', { scope, entryId: id, autoApply: true });
    expect(second.status).toBe('skipped');
  });

  it('moderate holds flagged content and passes clean content', async () => {
    const id = await seed(ctx);
    const records: string[] = [];
    const flagAi = new StubAIProvider((req: GenerateRequest) =>
      req.outputSchema ? { flagged: true, categories: ['hate'] } : '',
    );
    const held = await new InProcessAgentRuntime(
      makeActivities({ ctx, ai: flagAi, onRecord: (_s, _e, note) => void records.push(note) }),
    ).run('moderate', { scope, entryId: id });
    expect(held.status).toBe('held');
    expect(records[0]).toContain('moderation hold');

    const cleanAi = new StubAIProvider(() => ({ flagged: false, categories: [] }));
    const clean = await new InProcessAgentRuntime(makeActivities({ ctx, ai: cleanAi })).run(
      'moderate',
      { scope, entryId: id },
    );
    expect(clean.status).toBe('completed');
  });
});
