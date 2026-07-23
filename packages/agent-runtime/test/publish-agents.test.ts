import { describe, expect, it } from 'vitest';
import type { Activities, AgentRunResult, PublishAgentsHooks } from '../src/types.js';
import { publishAgentsWorkflow } from '../src/workflows.js';

const scope = { spaceId: 's', environmentId: 'main' };
const ZERO = { inputTokens: 0, outputTokens: 0 };

/**
 * The on-publish pass used to run in the queue consumer, which had to await
 * each result to record it, arm the HITL watcher and retract held entries.
 * These assert the workflow now owns all of that, so the consumer can start an
 * instance and ack.
 */
function fakeActivities(over: Partial<Activities> = {}) {
  const recorded: { workflow: string; entryId: string; status: string }[] = [];
  const retracted: string[] = [];
  const base: Activities = {
    loadEntry: async () => ({
      contentTypeApiId: 'article',
      displayField: 'title',
      defaultLocale: 'en-US',
      // `body` is empty, so enrich has something to fill.
      textFields: [
        { apiId: 'title', name: 'Title', hasValue: true },
        { apiId: 'body', name: 'Body', hasValue: false },
      ],
      fields: { title: { 'en-US': 'T' } },
      text: 'T',
    }),
    generateFields: async () => ({ fields: { body: { 'en-US': 'generated' } }, usage: ZERO }),
    applyFields: async () => {},
    classify: async () => ({ flagged: false, categories: [], usage: ZERO }),
    record: async () => {},
    createReview: async () => ({ reviewId: 'rev-1' }),
    armReview: async () => 'armed',
    settleReview: async () => {},
    recordRun: async (_s, run) => {
      recorded.push({ workflow: run.workflow, entryId: run.entryId, status: run.status });
    },
    retractEntry: async (_s, entryId) => {
      retracted.push(entryId);
    },
    ...over,
  } as Activities;
  return { act: base, recorded, retracted };
}

describe('publishAgentsWorkflow', () => {
  it('records a run per workflow per entry across the chunk', async () => {
    const { act, recorded } = fakeActivities();
    const out = await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1', 'e2'],
      enrich: true,
      moderate: true,
      autoApply: true,
    });
    // 2 entries × (enrich + moderate)
    expect(out).toHaveLength(4);
    expect(recorded.map((r) => `${r.entryId}:${r.workflow}`)).toEqual([
      'e1:enrich',
      'e1:moderate',
      'e2:enrich',
      'e2:moderate',
    ]);
  });

  it('runs enrich before moderate so moderation sees enriched content', async () => {
    const order: string[] = [];
    const { act } = fakeActivities({
      generateFields: async () => {
        order.push('enrich');
        return { fields: { body: { 'en-US': 'g' } }, usage: ZERO };
      },
      classify: async () => {
        order.push('moderate');
        return { flagged: false, categories: [], usage: ZERO };
      },
    });
    await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1'],
      enrich: true,
      moderate: true,
      autoApply: true,
    });
    expect(order).toEqual(['enrich', 'moderate']);
  });

  it('retracts a held entry from delivery and records the retraction', async () => {
    const { act, recorded, retracted } = fakeActivities({
      classify: async () => ({ flagged: true, categories: ['spam'], usage: ZERO }),
    });
    await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1'],
      enrich: false,
      moderate: true,
    });
    expect(retracted).toEqual(['e1']);
    // The hold plus the retraction note.
    expect(recorded.filter((r) => r.status === 'held')).toHaveLength(2);
  });

  it('does not retract when nothing is held', async () => {
    const { act, retracted } = fakeActivities();
    await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1'],
      enrich: false,
      moderate: true,
    });
    expect(retracted).toEqual([]);
  });

  it('arms the HITL watcher when a run needs review', async () => {
    const started: string[] = [];
    const hooks: PublishAgentsHooks = {
      startReviewWatcher: async (_s, reviewId) => {
        started.push(reviewId);
      },
    };
    // A real proposal with autoApply off routes to review.
    const { act } = fakeActivities();
    const out = await publishAgentsWorkflow(
      act,
      { scope, entryIds: ['e1'], enrich: true, moderate: false, autoApply: false },
      hooks,
    );
    // Concrete, not `started.length === needsReview.length` — that would pass
    // trivially if the run never reached needs_review at all.
    const needsReview = out.filter((r: AgentRunResult) => r.status === 'needs_review');
    expect(needsReview).toHaveLength(1);
    expect(started).toEqual(['rev-1']);
  });

  it('a failing watcher start never fails the pass', async () => {
    const hooks: PublishAgentsHooks = {
      startReviewWatcher: async () => {
        throw new Error('workflows unavailable');
      },
    };
    const { act, recorded } = fakeActivities();
    await expect(
      publishAgentsWorkflow(
        act,
        { scope, entryIds: ['e1'], enrich: true, moderate: false, autoApply: false },
        hooks,
      ),
    ).resolves.toBeDefined();
    expect(recorded).toHaveLength(1); // the run was still recorded
  });

  it('isolates a failing entry so the rest of the chunk still runs', async () => {
    // The consumer acks the whole chunk when it starts the instance, so an
    // exception escaping the pass would drop the remaining entries with no
    // retry and no dead-letter. Deterministic failures (e.g. an over-budget
    // entry) are the realistic case under a bulk publish.
    let n = 0;
    const { act, recorded } = fakeActivities({
      classify: async () => {
        n += 1;
        if (n === 2) throw new Error('budget exceeded');
        return { flagged: false, categories: [], usage: ZERO };
      },
    });
    const out = await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1', 'e2', 'e3'],
      enrich: false,
      moderate: true,
    });
    // e1 and e3 completed; e2 recorded a failure instead of aborting the chunk.
    expect(out.map((r) => r.entryId)).toEqual(['e1', 'e3']);
    const failed = recorded.find((r) => r.entryId === 'e2');
    expect(failed?.status).toBe('skipped');
  });

  it('does not record a retraction when retracting fails', async () => {
    // The ledger must never claim flagged content was pulled from delivery
    // when the unpublish actually failed.
    const { act, recorded } = fakeActivities({
      classify: async () => ({ flagged: true, categories: ['spam'], usage: ZERO }),
      retractEntry: async () => {
        throw new Error('store unavailable');
      },
    });
    await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1'],
      enrich: false,
      moderate: true,
    });
    expect(recorded.some((r) => r.status === 'held')).toBe(true);
    // The per-entry boundary caught it; no "retracted" claim was written.
    expect(recorded.filter((r) => r.status === 'held')).toHaveLength(1);
  });

  it('runs only the enabled workflows', async () => {
    const { act, recorded } = fakeActivities();
    await publishAgentsWorkflow(act, {
      scope,
      entryIds: ['e1'],
      enrich: true,
      moderate: false,
    });
    expect(recorded.map((r) => r.workflow)).toEqual(['enrich']);
  });
});
