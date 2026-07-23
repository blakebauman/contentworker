import {
  createAgentReview,
  createAgentSchedule,
  listAgentReviews,
  listAgentRuns,
  listAgentSchedules,
} from '@cw/application';
import { logger } from '@cw/telemetry';
import { backdated, localized, pick } from './helpers.js';
import type { SeedRun } from './types.js';

/**
 * Agent observability data: 30 days of deterministic runs (usage/cost charts),
 * pending human-in-the-loop reviews, and recurring schedules. Runs are written
 * through the store repo (there is deliberately no public "create run" API);
 * reviews and schedules go through their use-cases.
 */
export async function seedAgents(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope, locale } = run;

  if ((await listAgentRuns(ctx, scope, { limit: 1 })).length === 0) {
    await seedAgentRuns(run, articleIds);
  }

  if (articleIds.length >= 4 && (await listAgentReviews(ctx, scope, {})).length === 0) {
    for (let i = 0; i < 4; i++) {
      await createAgentReview(ctx, scope, {
        workflow: pick(['enrich', 'moderate'] as const, i),
        entryId: articleIds[i]!,
        proposed: {
          summary: localized(locale, `Agent-proposed summary revision #${i + 1}.`),
        },
        notes: [`Proposed a richer summary (seeded review ${i + 1})`],
      });
    }
  }

  if ((await listAgentSchedules(ctx, scope)).length === 0) {
    await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 6 * * *',
      contentTypeApiId: 'article',
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'moderate',
      cron: '*/30 * * * *',
      enabled: false,
      autoApply: true,
    });
  }
}

/**
 * Records a deterministic spread of agent runs across the last 30 days so the
 * dashboard's usage-trend, throughput, and per-workflow cards render
 * real-looking data. Timestamps are backdated off the injected clock; tokens
 * and statuses follow a fixed pattern (no randomness) for reproducible demos.
 * Runs reference real seeded entries so drill-downs resolve.
 */
async function seedAgentRuns(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now();
  const workflows = ['enrich', 'moderate', 'generate', 'curate', 'repurpose'] as const;
  const statuses = [
    'completed',
    'completed',
    'completed',
    'applied',
    'needs_review',
    'held',
    'failed',
  ] as const;

  let n = 0;
  for (let day = 29; day >= 0; day--) {
    // 0–4 runs per day, denser toward the present so week-over-week trends up.
    const count = Math.max(0, Math.round(4 - day / 8 + (day % 2 === 0 ? 1 : 0)) % 5);
    for (let k = 0; k < count; k++) {
      const workflow = workflows[n % workflows.length]!;
      await ctx.store.agentRuns.record(scope, {
        id: ctx.ids.newId(),
        workflow,
        entryId: articleIds.length ? pick(articleIds, n) : '',
        status: statuses[n % statuses.length]!,
        decisions: [`${workflow} pass ${n + 1}`],
        inputTokens: 420 + ((n * 137) % 900),
        outputTokens: 130 + ((n * 71) % 380),
        createdAt: backdated(now, day, 9 + ((k * 3) % 12)),
      });
      n++;
    }
  }
  logger.info({ runs: n }, 'seed: created sample agent runs');
}
