import { fileURLToPath } from 'node:url';
import { makeActivities } from '@cw/agent-runtime';
import { TemporalAgentRuntime } from '@cw/agent-runtime/temporal';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  decideAgentReview,
} from '@cw/application';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@cw/test-kit';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scope = { spaceId: 'hitl', environmentId: 'main' };
let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await testEnv?.teardown();
});

describe('HITL review via Temporal Signals (real ephemeral server)', () => {
  it('watcher waits durably; an approval signal applies the proposal exactly once', async () => {
    const store = new InMemoryContentStore();
    const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('h') };
    await createSpace(ctx, { spaceId: 'hitl', name: 'HITL', defaultLocale: 'en-US' });
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

    const ai = new StubAIProvider(() => ({ summary: 'A reviewed summary.' }));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'agents-test',
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities: makeActivities({ ctx, ai }),
    });
    const runtime = new TemporalAgentRuntime(testEnv.client as never, 'agents-test', ctx.ids);

    await worker.runUntil(async () => {
      // 1. The agent run proposes and persists a pending review.
      const run = await runtime.run('enrich', {
        scope,
        entryId: entry.entry.id,
        autoApply: false,
      });
      expect(run.status).toBe('needs_review');
      const reviewId = run.reviewId as string;
      expect(reviewId).toBeTruthy();

      // 2. Arm the detached durable watcher (as runPublishAgents does).
      await runtime.watchReview({ scope, reviewId, entryId: entry.entry.id });
      // Give the watcher a beat to arm (its first activity CASes `awaiting`).
      for (let i = 0; i < 50; i++) {
        const r = await store.agentReviews.get(scope, reviewId);
        if (r?.awaiting) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await store.agentReviews.get(scope, reviewId))?.awaiting).toBe(true);

      // 3. The human decides — the decision use-case delivers a Temporal
      //    Signal to the watcher, which owns applying the proposal.
      const decision = await decideAgentReview(
        ctx,
        scope,
        reviewId,
        { approve: true, decidedBy: 'reviewer@example.com' },
        { signalReview: (review) => runtime.signalReviewDecision(review.id, 'approved') },
      );
      expect(decision.signaled).toBe(true);
      expect(decision.applied).toBe(false); // the watcher applies, not the API

      // 4. The signaled watcher completes and applied the fields exactly once.
      const outcome = await testEnv.client.workflow.getHandle(`review-${reviewId}`).result();
      expect((outcome as { status: string }).status).toBe('completed');

      const got = await store.entries.get(scope, entry.entry.id);
      expect(got?.fields.summary?.['en-US']).toBe('A reviewed summary.');
      const review = await store.agentReviews.get(scope, reviewId);
      expect(review?.status).toBe('approved');
      expect(review?.appliedAt).toBeTruthy();
      // Exactly one applied version: v1 (create) + v2 (review apply).
      expect((await store.entries.listVersions(scope, entry.entry.id)).length).toBe(2);
    });
  }, 120_000);

  it('a rejection signal completes the watcher without applying', async () => {
    const store = new InMemoryContentStore();
    const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('j') };
    await createSpace(ctx, { spaceId: 'hitl', name: 'HITL', defaultLocale: 'en-US' });
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
    const ai = new StubAIProvider(() => ({ summary: 'Rejected summary.' }));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'agents-test',
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities: makeActivities({ ctx, ai }),
    });
    const runtime = new TemporalAgentRuntime(testEnv.client as never, 'agents-test', ctx.ids);

    await worker.runUntil(async () => {
      const run = await runtime.run('enrich', { scope, entryId: entry.entry.id, autoApply: false });
      const reviewId = run.reviewId as string;
      await runtime.watchReview({ scope, reviewId, entryId: entry.entry.id });
      for (let i = 0; i < 50; i++) {
        if ((await store.agentReviews.get(scope, reviewId))?.awaiting) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await decideAgentReview(
        ctx,
        scope,
        reviewId,
        { approve: false },
        { signalReview: (review) => runtime.signalReviewDecision(review.id, 'rejected') },
      );
      const outcome = await testEnv.client.workflow.getHandle(`review-${reviewId}`).result();
      expect((outcome as { status: string }).status).toBe('rejected');
      // Nothing applied; entry still at version 1.
      expect((await store.entries.listVersions(scope, entry.entry.id)).length).toBe(1);
      expect((await store.agentReviews.get(scope, reviewId))?.appliedAt).toBeUndefined();
    });
  }, 120_000);
});
