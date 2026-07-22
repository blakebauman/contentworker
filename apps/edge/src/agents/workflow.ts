import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import {
  type Activities,
  type AgentRunResult,
  type DurableWaits,
  makeActivities,
} from '@cw/agent-runtime';
import {
  curateWorkflow,
  enrichWorkflow,
  moderateWorkflow,
  repurposeWorkflow,
  reviewWorkflow,
} from '@cw/agent-runtime/workflows';
import { type AppContext, type FakeAdapterBinding, assertNoFakeAdapters } from '@cw/application';
import type { AIProvider, ContentStore, IdGenerator } from '@cw/ports';
import { InMemoryContentStore } from '@cw/test-kit';
import { v7 as uuidv7 } from 'uuid';
import { createDoCostGuard } from '../do/cost-guard.js';
import type { EdgeEnv } from '../env.js';
import { makeAI } from '../wire.js';
import { type AgentWfParams, REVIEW_DECISION_EVENT } from './runtime.js';

const workflows = {
  enrich: enrichWorkflow,
  moderate: moderateWorkflow,
  curate: curateWorkflow,
  repurpose: repurposeWorkflow,
} as const;

const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

/**
 * Wraps each Activities method in a `step.do`, making it a durable,
 * independently-retried step — the Cloudflare analogue of Temporal's
 * `proxyActivities` in apps/agent-worker. Activities I/O is plain JSON
 * (verified: no Dates/functions cross the seam), as `step.do` requires.
 */
function stepActivities(step: WorkflowStep, real: Activities): Activities {
  let n = 0;
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      // Activities I/O is plain JSON data, but step.do's Serializable<R>
      // constraint cannot see that through the generic — hence the cast.
      step.do(`${name}#${n++}`, STEP_CONFIG, (() => fn(...args)) as never) as Promise<R>;
  return {
    loadEntry: wrap('loadEntry', real.loadEntry.bind(real)),
    generateFields: wrap('generateFields', real.generateFields.bind(real)),
    applyFields: wrap('applyFields', real.applyFields.bind(real)),
    classify: wrap('classify', real.classify.bind(real)),
    record: wrap('record', real.record.bind(real)),
    createReview: wrap('createReview', real.createReview.bind(real)),
    armReview: wrap('armReview', real.armReview.bind(real)),
    settleReview: wrap('settleReview', real.settleReview.bind(real)),
  };
}

/**
 * One generic Workflow entrypoint hosts all four agent workflows (selected by
 * params), mirroring how apps/agent-worker hosts them on Temporal: the pure
 * orchestration fns from @cw/agent-runtime run unchanged; only the Activities
 * implementation differs (step-wrapped here, proxied there). Deps are wired
 * per instance from bindings — this class is a composition root export.
 */
export class AgentWorkflow extends WorkflowEntrypoint<EdgeEnv, AgentWfParams> {
  override async run(
    event: WorkflowEvent<AgentWfParams>,
    step: WorkflowStep,
  ): Promise<AgentRunResult> {
    const { workflow, input } = event.payload;
    const run = workflow === 'review' ? undefined : workflows[workflow];
    if (workflow !== 'review' && !run) throw new Error(`unknown agent workflow "${workflow}"`);

    // Durable runs need the shared database: without HYPERDRIVE this store is
    // a fresh empty in-memory one (the demo store lives in the fetch isolate),
    // so demo deployments keep AGENT_RUNTIME unset and run agents in-process.
    const connectionString = this.env.HYPERDRIVE?.connectionString ?? this.env.DATABASE_URL;
    const store: ContentStore = connectionString
      ? createPostgresStore(connectionString, { max: 2, fetchTypes: false })
      : (new InMemoryContentStore() as ContentStore);
    // Same fail-closed policy as wireEdge: a durable run against the real
    // database must not persist StubAIProvider placeholders. Workflow
    // invocations don't pass through wireEdge, so the guard is repeated here.
    const fakes: FakeAdapterBinding[] = [];
    const ai: AIProvider = makeAI(this.env, fakes);
    assertNoFakeAdapters({
      persistent: Boolean(connectionString),
      allowFakeAdapters: this.env.ALLOW_FAKE_ADAPTERS,
      fakes,
    });
    const ids: IdGenerator = { newId: () => uuidv7() };
    // Durable runs meter against the background agent window (`agent:` DO
    // prefix) — previously workflow-hosted generations were unmetered.
    const costGuard = this.env.AI_BUDGET
      ? createDoCostGuard(this.env.AI_BUDGET, 'agent:')
      : undefined;
    const ctx: AppContext = { store, clock: { now: () => new Date() }, ids, costGuard };

    try {
      const activities = stepActivities(step, makeActivities({ ctx, ai }));
      if (event.payload.workflow === 'review') {
        // HITL watcher: the human decision arrives as a Workflow event;
        // waitForEvent parks durably (days) and rejects on timeout → null.
        const waits: DurableWaits = {
          awaitReviewDecision: async (reviewId, timeoutMs) => {
            try {
              const decided = await step.waitForEvent<'approved' | 'rejected'>(
                `decision:${reviewId}`,
                { type: REVIEW_DECISION_EVENT, timeout: timeoutMs },
              );
              return decided.payload ?? null;
            } catch {
              return null;
            }
          },
        };
        return await reviewWorkflow(activities, event.payload.input, waits);
      }
      if (!run) throw new Error(`unknown agent workflow "${workflow}"`);
      return await run(activities, input as import('@cw/agent-runtime').WorkflowInput);
    } finally {
      if (connectionString) await (store as ContentStore & { close(): Promise<void> }).close();
    }
  }
}
