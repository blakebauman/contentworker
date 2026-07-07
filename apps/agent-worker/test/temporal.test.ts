import { fileURLToPath } from 'node:url';
import { makeActivities } from '@cw/agent-runtime';
import { type AppContext, createContentType, createEntry, createSpace } from '@cw/application';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@cw/test-kit';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scope = { spaceId: 'blog', environmentId: 'main' };
let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await testEnv?.teardown();
});

describe('Temporal agent execution (real ephemeral server)', () => {
  it('runs the enrich workflow durably: activities apply enrichment to the store', async () => {
    // In-memory store shared between the seeding code and the activities.
    const store = new InMemoryContentStore();
    const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
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
      ],
    });
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });

    const ai = new StubAIProvider(() => ({ summary: 'A short generated summary.' }));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'agents-test',
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities: makeActivities({ ctx, ai }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute('enrich', {
        taskQueue: 'agents-test',
        workflowId: `wf-${entry.entry.id}`,
        args: [{ scope, entryId: entry.entry.id, autoApply: true }],
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.decisions[0]).toContain('summary');
    // The activity actually wrote the enriched field to the store.
    const got = await store.entries.get(scope, entry.entry.id);
    expect(got?.fields.summary?.['en-US']).toBe('A short generated summary.');
  }, 120_000);

  it('runs the repurpose workflow durably: channel variants come back as a review proposal', async () => {
    const store = new InMemoryContentStore();
    const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, scope, {
      apiId: 'note',
      name: 'Note',
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
      ],
    });
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Release notes for v2' } },
    });

    const ai = new StubAIProvider(() => ({
      summary: 'v2 ships faster queries.',
      socialPost: 'v2 is out!',
      emailTeaser: 'See what shipped in v2.',
    }));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'agents-test',
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities: makeActivities({ ctx, ai }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute('repurpose', {
        taskQueue: 'agents-test',
        workflowId: `wf-repurpose-${entry.entry.id}`,
        args: [{ scope, entryId: entry.entry.id }],
      }),
    );

    expect(result.status).toBe('needs_review');
    expect(result.proposed?.socialPost?.['en-US']).toBe('v2 is out!');
    // Variants are proposals only — the entry itself is untouched.
    expect((await store.entries.get(scope, entry.entry.id))?.entry.currentVersion).toBe(1);
  }, 120_000);
});
