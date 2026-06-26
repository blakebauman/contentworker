import { ForbiddenError, InvalidStateError, NotFoundError, SCOPES } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  defineWorkflow,
  getEntryWorkflowState,
  transitionEntry,
} from '../src/index.js';

const scope = { spaceId: 'space-1', environmentId: 'main' };

const STEPS = [
  { id: 'draft', name: 'Draft', requiredScope: SCOPES.contentWrite },
  { id: 'review', name: 'In review', requiredScope: SCOPES.contentWrite },
  { id: 'approved', name: 'Approved', requiredScope: SCOPES.contentPublish },
] as const;

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedEntry(ctx: AppContext) {
  await createContentType(ctx, scope, {
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
    ],
  });
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Doc' } },
  });
}

describe('workflows', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = makeContext();
  });

  it('defines a workflow and moves an entry through allowed steps', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });

    const writerScopes = [SCOPES.contentWrite];
    const state = await transitionEntry(
      ctx,
      scope,
      { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'review' },
      writerScopes,
    );
    expect(state.currentStepId).toBe('review');
    expect(await getEntryWorkflowState(ctx, scope, entry.entry.id)).toMatchObject({
      currentStepId: 'review',
      workflowId: wf.id,
    });
  });

  it('forbids entering a step whose required scope the caller lacks', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });

    // A writer (no content:publish) cannot move the entry to "approved".
    await expect(
      transitionEntry(
        ctx,
        scope,
        { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'approved' },
        [SCOPES.contentWrite],
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // An editor with content:publish can.
    const state = await transitionEntry(
      ctx,
      scope,
      { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'approved' },
      [SCOPES.contentWrite, SCOPES.contentPublish],
    );
    expect(state.currentStepId).toBe('approved');
  });

  it('rejects transitioning to an unknown step', async () => {
    const entry = await seedEntry(ctx);
    const wf = await defineWorkflow(ctx, scope, { name: 'Editorial', steps: [...STEPS] });
    await expect(
      transitionEntry(
        ctx,
        scope,
        { entryId: entry.entry.id, workflowId: wf.id, toStepId: 'nope' },
        [SCOPES.contentWrite, SCOPES.contentPublish],
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('validates the workflow definition (no empty steps, no duplicate ids)', async () => {
    await expect(defineWorkflow(ctx, scope, { name: 'X', steps: [] })).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await expect(
      defineWorkflow(ctx, scope, {
        name: 'X',
        steps: [
          { id: 'a', name: 'A', requiredScope: SCOPES.contentWrite },
          { id: 'a', name: 'A2', requiredScope: SCOPES.contentWrite },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});
