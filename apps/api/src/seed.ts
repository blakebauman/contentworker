import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getContentType,
  getSpaceConfig,
  publishContentType,
  publishEntry,
} from '@cw/application';
import { type ApiKeyKind, scopesForKind } from '@cw/domain';
import { logger } from '@cw/telemetry';
import { sha256Hasher } from './auth.js';
import type { ApiConfig } from './config.js';

/**
 * Idempotently bootstraps a usable dev environment against a real database:
 * the seed space, the three dev API keys (stored as hashes), and a published
 * "article" content type with one sample entry. Safe to run on every boot.
 *
 * The in-memory store seeds its own space/keys in wire.ts; this exists so a
 * fresh Postgres stack (docker compose) authenticates and has content to show.
 */
export async function seedDev(ctx: AppContext, config: ApiConfig): Promise<void> {
  const scope = { spaceId: config.seed.spaceId, environmentId: config.seed.environmentId };

  // 1. Space + environment (skip if it already exists).
  if (!(await spaceExists(ctx, scope))) {
    await createSpace(ctx, {
      spaceId: config.seed.spaceId,
      name: config.seed.spaceId,
      defaultLocale: config.seed.defaultLocale,
      locales: config.seed.locales,
      environments: [config.seed.environmentId],
    });
    logger.info({ space: config.seed.spaceId }, 'seed: created space');
  }

  // 2. Dev API keys — insert each only if its hashed token isn't present yet.
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    const hashedToken = sha256Hasher.hash(token);
    if (!(await ctx.store.auth.findByHash(hashedToken))) {
      await ctx.store.auth.createApiKey({
        id: ctx.ids.newId(),
        spaceId: config.seed.spaceId,
        kind,
        name: `dev-${kind}`,
        hashedToken,
        scopes: scopesForKind(kind),
        revoked: false,
      });
      logger.info({ kind }, 'seed: created dev api key');
    }
  }

  // 3. A demo "article" content type + one published entry (skip if present).
  if (!(await contentTypeExists(ctx, scope, 'article'))) {
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: true,
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
    await publishContentType(ctx, scope, 'article');

    const locale = config.seed.defaultLocale;
    const view = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { [locale]: 'Welcome to contentworker' },
        body: { [locale]: 'This entry was seeded by SEED_DEV. Edit or publish it from the admin.' },
      },
    });
    await publishEntry(ctx, scope, view.entry.id);
    logger.info('seed: created demo article + sample entry');
  }
}

async function spaceExists(ctx: AppContext, scope: { spaceId: string; environmentId: string }) {
  try {
    await getSpaceConfig(ctx, scope);
    return true;
  } catch {
    return false;
  }
}

async function contentTypeExists(
  ctx: AppContext,
  scope: { spaceId: string; environmentId: string },
  apiId: string,
) {
  try {
    await getContentType(ctx, scope, apiId);
    return true;
  } catch {
    return false;
  }
}
