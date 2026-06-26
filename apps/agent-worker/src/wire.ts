import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import { createAzureOpenAIProvider } from '@cw/adapter-ai-azure-openai';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { type Activities, makeActivities } from '@cw/agent-runtime';
import type { AppContext } from '@cw/application';
import type { AIProvider, Clock, ContentStore, IdGenerator } from '@cw/ports';
import { InMemoryContentStore } from '@cw/test-kit';
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
  const ctx: AppContext = { store, clock, ids };
  return { activities: makeActivities({ ctx, ai }), ids };
}
