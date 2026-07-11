import {
  type AppContext,
  addEntryToRelease,
  createConcept,
  createContentType,
  createEntry,
  createRelease,
  createScheme,
  createSpace,
  createTag,
  getContentType,
  getSpaceConfig,
  listAgentRuns,
  listConcepts,
  listPreviewEntries,
  listReleases,
  listSchemes,
  listTags,
  publishContentType,
  publishEntry,
  setEntryMetadata,
} from '@cw/application';
import {
  type ApiKeyKind,
  type ContentTypeDraft,
  type EntryFields,
  type Scope,
  scopesForKind,
} from '@cw/domain';
import { logger } from '@cw/telemetry';
import { createApiHasher } from './auth.js';
import type { ApiConfig } from './config.js';

/**
 * Idempotently bootstraps a usable dev environment against a real database:
 * the seed space, dev API keys, demo content types, entries, taxonomy, and a
 * sample release. Safe to run on every boot.
 *
 * The in-memory store seeds its own space/keys in wire.ts; this exists so a
 * fresh Postgres stack (docker compose) authenticates and has content to show.
 */
export async function seedDev(ctx: AppContext, config: ApiConfig): Promise<void> {
  const hasher = createApiHasher(config.tokenPepper);
  const scope = { spaceId: config.seed.spaceId, environmentId: config.seed.environmentId };
  const locale = config.seed.defaultLocale;
  const locales = config.seed.locales;

  // 1. Space + environment (skip if it already exists).
  if (!(await spaceExists(ctx, scope))) {
    await createSpace(ctx, {
      spaceId: config.seed.spaceId,
      name: config.seed.spaceId,
      defaultLocale: locale,
      locales,
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
    const hashedToken = hasher.hash(token);
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

  // 3. Demo content model + corpus.
  await seedDemoContent(ctx, scope, locale, locales);

  // 4. Sample agent runs so the dashboard's usage charts aren't empty on a
  //    fresh stack. Skip once any run exists (keeps the seed idempotent).
  if ((await listAgentRuns(ctx, scope, { limit: 1 })).length === 0) {
    await seedAgentRuns(ctx, scope);
  }
}

async function seedDemoContent(
  ctx: AppContext,
  scope: Scope,
  locale: string,
  locales: readonly string[],
): Promise<void> {
  const hasDe = locales.includes('de-DE');
  let created = 0;

  await ensureContentType(ctx, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'role',
        name: 'Role',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'bio',
        name: 'Bio',
        type: 'Text',
        localized: true,
        required: false,
        position: 2,
      },
    ],
  });

  await ensureContentType(ctx, scope, {
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
      {
        apiId: 'summary',
        name: 'Summary',
        type: 'Symbol',
        localized: true,
        required: false,
        position: 2,
      },
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 3,
        validations: { linkContentTypes: ['author'] },
      },
      {
        apiId: 'views',
        name: 'Views',
        type: 'Integer',
        localized: false,
        required: false,
        position: 4,
      },
      {
        apiId: 'featured',
        name: 'Featured',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 5,
      },
    ],
  });

  await ensureContentType(ctx, scope, {
    apiId: 'page',
    name: 'Page',
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
        apiId: 'slug',
        name: 'Slug',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 1,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: true,
        required: false,
        position: 2,
      },
      {
        apiId: 'seoDescription',
        name: 'SEO description',
        type: 'Text',
        localized: true,
        required: false,
        position: 3,
      },
    ],
  });

  await ensureContentType(ctx, scope, {
    apiId: 'product',
    name: 'Product',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      {
        apiId: 'description',
        name: 'Description',
        type: 'Text',
        localized: true,
        required: false,
        position: 1,
      },
      {
        apiId: 'price',
        name: 'Price',
        type: 'Number',
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'inStock',
        name: 'In stock',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 3,
      },
    ],
  });

  const jordanId = await ensurePublishedEntry(ctx, scope, locale, 'author', 'name', 'Jordan Lee', {
    name: localized(locale, 'Jordan Lee'),
    role: localized(locale, 'Staff writer'),
    bio: localized(
      locale,
      'Writes about CMS architecture and developer experience.',
      hasDe ? { 'de-DE': 'Schreibt über CMS-Architektur und Developer Experience.' } : undefined,
    ),
  });
  if (jordanId.created) created++;

  const alexId = await ensurePublishedEntry(ctx, scope, locale, 'author', 'name', 'Alex Kim', {
    name: localized(locale, 'Alex Kim'),
    role: localized(locale, 'Editor'),
    bio: localized(locale, 'Curates tutorials and release notes.'),
  });
  if (alexId.created) created++;

  const link = (id: string) => ({ [locale]: { id, linkType: 'Entry' as const } });

  const articleSeeds = [
    {
      title: 'Welcome to contentworker',
      fields: {
        title: localized(
          locale,
          'Welcome to contentworker',
          hasDe ? { 'de-DE': 'Willkommen bei contentworker' } : undefined,
        ),
        body: localized(
          locale,
          'This entry was seeded by SEED_DEV. Edit or publish it from the admin.',
        ),
        summary: localized(locale, 'Your headless CMS dev environment is ready.'),
        author: link(jordanId.id),
        views: localized(locale, 128),
        featured: localized(locale, true),
      },
    },
    {
      title: 'Getting started with the Management API',
      fields: {
        title: localized(
          locale,
          'Getting started with the Management API',
          hasDe ? { 'de-DE': 'Erste Schritte mit der Management API' } : undefined,
        ),
        body: localized(
          locale,
          'Use dev-cma-key to create content types, author entries, and publish.',
        ),
        summary: localized(locale, 'A quick tour of the CMA endpoints.'),
        author: link(jordanId.id),
        views: localized(locale, 842),
        featured: localized(locale, true),
      },
    },
    {
      title: 'Hexagonal architecture in practice',
      fields: {
        title: localized(locale, 'Hexagonal architecture in practice'),
        body: localized(
          locale,
          'Domain logic stays adapter-free; apps bind Postgres, Redis, and AI at the edge.',
        ),
        summary: localized(locale, 'How contentworker keeps ports and adapters strict.'),
        author: link(alexId.id),
        views: localized(locale, 415),
        featured: localized(locale, false),
      },
    },
    {
      title: 'Building with AI agents',
      fields: {
        title: localized(locale, 'Building with AI agents'),
        body: localized(
          locale,
          'MCP tools call the same use-cases as the HTTP API — agents cannot bypass RBAC.',
        ),
        summary: localized(locale, 'Agentic workflows without a separate back door.'),
        author: link(alexId.id),
        views: localized(locale, 1203),
        featured: localized(locale, true),
      },
    },
    {
      title: 'Delivery API query patterns',
      fields: {
        title: localized(locale, 'Delivery API query patterns'),
        body: localized(
          locale,
          'Filter, sort, and select fields on published entries with dev-cda-key.',
        ),
        summary: localized(locale, 'Read-model queries for front-end apps.'),
        author: link(jordanId.id),
        views: localized(locale, 267),
        featured: localized(locale, false),
      },
    },
  ] as const;

  const articleIds: string[] = [];
  for (const seed of articleSeeds) {
    const result = await ensurePublishedEntry(
      ctx,
      scope,
      locale,
      'article',
      'title',
      seed.title,
      seed.fields,
    );
    if (result.created) created++;
    articleIds.push(result.id);
  }

  const pageSeeds = [
    {
      title: 'Home',
      fields: {
        title: localized(locale, 'Home', hasDe ? { 'de-DE': 'Startseite' } : undefined),
        slug: localized(locale, 'home'),
        body: localized(
          locale,
          richTextDoc('Welcome to the demo site.'),
          hasDe ? { 'de-DE': richTextDoc('Willkommen auf der Demo-Seite.') } : undefined,
        ),
        seoDescription: localized(locale, 'Demo home page seeded for local development.'),
      },
    },
    {
      title: 'About us',
      fields: {
        title: localized(locale, 'About us'),
        slug: localized(locale, 'about'),
        body: localized(locale, richTextDoc('contentworker is an API-first headless CMS.')),
        seoDescription: localized(locale, 'Learn about the contentworker project.'),
      },
    },
    {
      title: 'Documentation',
      fields: {
        title: localized(locale, 'Documentation'),
        slug: localized(locale, 'docs'),
        body: localized(
          locale,
          richTextDoc('See docs/ in the repository for architecture and configuration.'),
        ),
        seoDescription: localized(locale, 'Developer documentation index.'),
      },
    },
  ] as const;

  for (const seed of pageSeeds) {
    const result = await ensurePublishedEntry(
      ctx,
      scope,
      locale,
      'page',
      'title',
      seed.title,
      seed.fields,
    );
    if (result.created) created++;
  }

  const productSeeds = [
    {
      name: 'Starter',
      fields: {
        name: localized(locale, 'Starter'),
        description: localized(locale, 'Single space, in-memory or Postgres, ideal for local dev.'),
        price: localized(locale, 0),
        inStock: localized(locale, true),
      },
    },
    {
      name: 'Pro',
      fields: {
        name: localized(locale, 'Pro'),
        description: localized(locale, 'Multi-environment branching, releases, and webhooks.'),
        price: localized(locale, 49),
        inStock: localized(locale, true),
      },
    },
    {
      name: 'Enterprise',
      fields: {
        name: localized(locale, 'Enterprise'),
        description: localized(locale, 'Granular RBAC, SSO, and dedicated agent runtime.'),
        price: localized(locale, 199),
        inStock: localized(locale, false),
      },
    },
  ] as const;

  for (const seed of productSeeds) {
    const result = await ensurePublishedEntry(
      ctx,
      scope,
      locale,
      'product',
      'name',
      seed.name,
      seed.fields,
    );
    if (result.created) created++;
  }

  created += await seedTaxonomy(ctx, scope, articleIds);
  created += await seedRelease(ctx, scope, articleIds.slice(0, 2));

  if (created > 0) {
    logger.info({ created }, 'seed: demo content ensured');
  }
}

async function seedTaxonomy(
  ctx: AppContext,
  scope: Scope,
  articleIds: readonly string[],
): Promise<number> {
  let created = 0;

  let scheme = (await listSchemes(ctx, scope)).find((s) => s.name === 'Topics');
  if (!scheme) {
    scheme = await createScheme(ctx, scope, { name: 'Topics' });
    created++;
  }

  const concepts = await listConcepts(ctx, scope, scheme.id);
  const ensureConcept = async (prefLabel: string, broaderId?: string | null) => {
    const existing = concepts.find((c) => c.schemeId === scheme!.id && c.prefLabel === prefLabel);
    if (existing) return existing;
    const concept = await createConcept(ctx, scope, {
      schemeId: scheme!.id,
      prefLabel,
      broaderId,
    });
    concepts.push(concept);
    created++;
    return concept;
  };

  const cms = await ensureConcept('Content management');
  const ai = await ensureConcept('AI & automation');
  await ensureConcept('CMS basics', cms.id);
  await ensureConcept('Agent workflows', ai.id);

  const tagNames = ['featured', 'tutorial', 'announcement'] as const;
  const tags = await listTags(ctx, scope);
  const tagIds: string[] = [];
  for (const name of tagNames) {
    let tag = tags.find((t) => t.name === name);
    if (!tag) {
      tag = await createTag(ctx, scope, { name });
      tags.push(tag);
      created++;
    }
    tagIds.push(tag.id);
  }

  if (articleIds[0]) {
    const metadata = await ctx.store.taxonomy.getEntryMetadata(scope, articleIds[0]);
    if (!metadata?.tags.length) {
      await setEntryMetadata(ctx, scope, articleIds[0], {
        tags: [tagIds[0]!, tagIds[2]!],
        concepts: [cms.id],
      });
      created++;
    }
  }
  if (articleIds[1]) {
    const metadata = await ctx.store.taxonomy.getEntryMetadata(scope, articleIds[1]);
    if (!metadata?.tags.length) {
      await setEntryMetadata(ctx, scope, articleIds[1], {
        tags: [tagIds[1]!],
        concepts: [cms.id],
      });
      created++;
    }
  }

  return created;
}

async function seedRelease(
  ctx: AppContext,
  scope: Scope,
  entryIds: readonly string[],
): Promise<number> {
  const title = 'Spring demo release';
  if ((await listReleases(ctx, scope)).some((r) => r.title === title)) return 0;
  if (entryIds.length === 0) return 0;

  const release = await createRelease(ctx, scope, {
    title,
    description: 'Sample release bundling seeded articles for the Releases UI.',
  });
  for (const entityId of entryIds) {
    await addEntryToRelease(ctx, scope, release.id, { entityId });
  }
  return 1;
}

function richTextDoc(text: string) {
  return {
    nodeType: 'document' as const,
    content: [
      {
        nodeType: 'paragraph' as const,
        content: [{ nodeType: 'text' as const, value: text, marks: [] as const }],
      },
    ],
  };
}

function localized(
  defaultLocale: string,
  value: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { [defaultLocale]: value };
  if (extra) {
    for (const [loc, v] of Object.entries(extra)) out[loc] = v;
  }
  return out;
}

async function ensureContentType(
  ctx: AppContext,
  scope: Scope,
  draft: ContentTypeDraft,
): Promise<void> {
  const existed = await contentTypeExists(ctx, scope, draft.apiId);
  await createContentType(ctx, scope, draft);
  await publishContentType(ctx, scope, draft.apiId);
  if (!existed) {
    logger.info({ apiId: draft.apiId }, 'seed: created content type');
  }
}

async function ensurePublishedEntry(
  ctx: AppContext,
  scope: Scope,
  locale: string,
  contentTypeApiId: string,
  matchField: string,
  matchValue: string,
  fields: EntryFields,
): Promise<{ id: string; created: boolean }> {
  const existing = await findEntryByField(
    ctx,
    scope,
    contentTypeApiId,
    matchField,
    matchValue,
    locale,
  );
  if (existing) return { id: existing, created: false };

  const view = await createEntry(ctx, scope, { contentTypeApiId, fields });
  await publishEntry(ctx, scope, view.entry.id);
  return { id: view.entry.id, created: true };
}

async function findEntryByField(
  ctx: AppContext,
  scope: Scope,
  contentTypeApiId: string,
  field: string,
  value: string,
  locale: string,
): Promise<string | null> {
  const rows = await listPreviewEntries(ctx, scope, {
    contentTypeApiId,
    filters: [{ field, op: 'eq', value }],
    locale,
    limit: 1,
  });
  return rows[0]?.id ?? null;
}

/**
 * Records a deterministic spread of agent runs across the last 14 days so the
 * dashboard's usage-trend, throughput, and per-workflow cards render real-looking
 * data in dev/demo. Timestamps are backdated off the injected clock; tokens and
 * statuses follow a fixed pattern (no randomness) for reproducible demos.
 */
async function seedAgentRuns(ctx: AppContext, scope: Scope): Promise<void> {
  const now = ctx.clock.now();
  const workflows = ['enrich', 'moderate', 'generate'] as const;
  const statuses = ['completed', 'completed', 'completed', 'needs_review', 'held'] as const;

  let n = 0;
  for (let day = 13; day >= 0; day--) {
    // 0–3 runs per day, denser toward the present so week-over-week trends up.
    const count = Math.max(0, Math.round(3 - day / 5 + (day % 2 === 0 ? 1 : 0)) % 4);
    for (let k = 0; k < count; k++) {
      const created = new Date(now);
      created.setDate(created.getDate() - day);
      created.setHours(9 + k * 3, 15, 0, 0);
      const workflow = workflows[n % workflows.length]!;
      await ctx.store.agentRuns.record(scope, {
        id: ctx.ids.newId(),
        workflow,
        entryId: '',
        status: statuses[n % statuses.length]!,
        decisions: [`${workflow} pass ${n + 1}`],
        inputTokens: 420 + ((n * 137) % 900),
        outputTokens: 130 + ((n * 71) % 380),
        createdAt: created.toISOString(),
      });
      n++;
    }
  }
  logger.info({ runs: n }, 'seed: created sample agent runs');
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
