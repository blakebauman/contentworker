import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  auditEntry,
  createContentType,
  createEntry,
  createSpace,
  listTasks,
} from '../src/index.js';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

const FINDINGS = {
  findings: [
    {
      field: 'title',
      severity: 'error',
      message: 'Title is empty',
      suggestedAction: 'Add a title',
    },
    { severity: 'warning', message: 'Body is thin', suggestedAction: 'Expand the body' },
    { severity: 'info', message: 'Consider a CTA', suggestedAction: 'Add a call to action' },
  ],
};

describe('auditEntry', () => {
  let ctx: AppContext;
  let entryId: string;
  beforeEach(async () => {
    ({ ctx } = setup());
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
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hi' }, body: { 'en-US': 'Short.' } },
    });
    entryId = entry.id;
  });

  it('returns structured findings without creating tasks by default', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId);
    expect(result.findings).toHaveLength(3);
    expect(result.taskIds).toEqual([]);
    expect(await listTasks(ctx, scope, entryId)).toHaveLength(0);
  });

  it('emits a work-package task per finding at/above the severity threshold', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId, {
      createTasks: true,
      taskSeverity: 'warning',
      assignee: 'editor@example.com',
    });
    // error + warning qualify; info does not.
    expect(result.taskIds).toHaveLength(2);
    const tasks = await listTasks(ctx, scope, entryId);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.assignee).toBe('editor@example.com');
    expect(tasks.some((t) => t.body.includes('Add a title'))).toBe(true);
  });

  it('only creates tasks for errors when taskSeverity=error', async () => {
    const ai = new StubAIProvider(() => FINDINGS);
    const result = await auditEntry(ctx, ai, scope, entryId, {
      createTasks: true,
      taskSeverity: 'error',
    });
    expect(result.taskIds).toHaveLength(1);
  });
});
