import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import { createAzureOpenAIProvider } from '@cw/adapter-ai-azure-openai';
import { createRedisCostGuard } from '@cw/adapter-redis';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { type Activities, makeActivities } from '@cw/agent-runtime';
import { type AppContext, agentBudgetLimits, aiBudgetLimits } from '@cw/application';
import type { AIProvider, Clock, ContentStore, CostGuard, IdGenerator } from '@cw/ports';
import { InMemoryContentStore, InMemoryCostGuard } from '@cw/test-kit';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { newId: () => uuidv7() };

/** Builds the activities implementation the Temporal worker registers. */
export function wireActivities(env: NodeJS.ProcessEnv = process.env): {
  activities: Activities;
  ids: IdGenerator;
} {
  const store: ContentStore = env.DATABASE_URL
    ? createPostgresStore(env.DATABASE_URL)
    : (new InMemoryContentStore() as ContentStore);
  const ai: AIProvider =
    env.AI_PROVIDER === 'azure-openai' ? createAzureOpenAIProvider() : createAnthropicProvider();
  // Every workflow this host executes is BACKGROUND agent work, so prefer the
  // AI_AGENT_* window (separate `cwagent` Redis keys) when configured — batch
  // spend then can't exhaust the interactive window. Falls back to the shared
  // interactive window, then to an in-process window for single-node/dev.
  const agentLimits = agentBudgetLimits(env);
  const limits = agentLimits ?? aiBudgetLimits(env);
  let costGuard: CostGuard | undefined;
  if (limits) {
    costGuard = env.REDIS_URL
      ? createRedisCostGuard(
          new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
          limits,
          agentLimits ? { keyPrefix: 'cwagent' } : {},
        )
      : new InMemoryCostGuard(limits);
  }
  const ctx: AppContext = { store, clock, ids, costGuard };
  return { activities: makeActivities({ ctx, ai }), ids };
}
