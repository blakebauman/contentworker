import { logger } from '@cw/telemetry';
import {
  WORDS,
  assetLink,
  ensurePublishedEntry,
  entryLink,
  localized,
  pick,
  richTextDoc,
  richTextKitchenSink,
  seedGeneratedEntries,
  statusFor,
} from './helpers.js';
import type { TaxonomySeed } from './taxonomy.js';
import type { SeedRun } from './types.js';

export interface CorpusSeed {
  readonly articleIds: readonly string[];
  readonly productIds: readonly string[];
  /** Ids of generated entries left as drafts (scheduling/publish demos). */
  readonly draftArticleIds: readonly string[];
}

/** Generated-type volumes; the bulk types scale linearly for benchmarking. */
export function volumes(scale: number) {
  return {
    authors: 12,
    categories: 12,
    articles: 100 * scale,
    products: 30 * scale,
    events: 25 * scale,
    recipes: 20 * scale,
    pages: 12,
    landingPages: 8,
  };
}

/**
 * The entry corpus: a small curated showcase (stable titles the docs and
 * e2e flows can rely on) plus a deterministic generated dataset sized by
 * `scale`. Ordering respects publish-time referential integrity: link targets
 * (categories, authors, assets, products) are seeded before their referrers.
 */
export async function seedCorpus(
  run: SeedRun,
  assetIds: readonly string[],
  taxonomy: TaxonomySeed,
): Promise<CorpusSeed> {
  const { locale, hasDe, scale } = run;
  const vol = volumes(scale);
  const asset = (i: number) => (assetIds.length ? assetLink(pick(assetIds, i)) : undefined);

  // --- categories (tree: roots first so children can reference real ids) ----
  const CATEGORY_ROOTS = ['Engineering', 'Product', 'Business'] as const;
  const rootCategoryIds = await seedGeneratedEntries(
    run,
    'category',
    'name',
    CATEGORY_ROOTS.length,
    (i) => ({
      matchValue: CATEGORY_ROOTS[i]!,
      status: 'published',
      fields: {
        name: localized(locale, CATEGORY_ROOTS[i]!),
        slug: localized(locale, CATEGORY_ROOTS[i]!.toLowerCase()),
      },
    }),
  );
  const childCategoryIds = await seedGeneratedEntries(
    run,
    'category',
    'name',
    vol.categories - CATEGORY_ROOTS.length,
    (i) => {
      const name = `${pick(CATEGORY_ROOTS, i)} / ${pick(WORDS.topics, i)}`;
      return {
        matchValue: name,
        status: 'published',
        fields: {
          name: localized(locale, name),
          slug: localized(locale, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
          parent: localized(locale, entryLink(pick(rootCategoryIds, i))),
        },
      };
    },
  );
  const categoryIds = [...rootCategoryIds, ...childCategoryIds];

  // --- authors --------------------------------------------------------------
  const authorIds = await seedGeneratedEntries(run, 'author', 'name', vol.authors, (i) => {
    const first = pick(['Jordan', 'Alex', 'Sam', 'Riley', 'Casey', 'Morgan'] as const, i);
    const last = pick(['Lee', 'Kim', 'Rivera', 'Patel', 'Nguyen', 'Okafor'] as const, i * 5 + 1);
    const name = `${first} ${last}`;
    return {
      matchValue: name,
      status: 'published',
      fields: {
        name: localized(locale, name),
        role: localized(locale, pick(['Staff writer', 'Editor', 'Guest author'] as const, i)),
        bio: localized(
          locale,
          `Writes about ${pick(WORDS.topics, i)} and ${pick(WORDS.topics, i + 3)}.`,
          hasDe ? { 'de-DE': `Schreibt über ${pick(WORDS.topics, i)}.` } : undefined,
        ),
      },
    };
  });

  // --- products -------------------------------------------------------------
  const productIds = await seedGeneratedEntries(run, 'product', 'name', vol.products, (i) => {
    const name = `${pick(WORDS.adjectives, i)} ${pick(['Workspace', 'Toolkit', 'Console', 'Bundle', 'Kit'] as const, i)} ${i}`;
    return {
      matchValue: name,
      status: statusFor(i),
      fields: {
        name: localized(locale, name),
        description: localized(locale, `The ${name} for ${pick(WORDS.topics, i)} teams.`),
        price: localized(locale, 9 + (i % 20) * 10),
        inStock: localized(locale, i % 4 !== 0),
        sku: localized(locale, `${pick(['CW', 'PR', 'KT'] as const, i)}-${String(1000 + i)}`),
        images: localized(locale, [asset(i), asset(i + 1)].filter(Boolean)),
        specs: localized(locale, {
          weightKg: (i % 5) + 0.5,
          dimensions: { w: 10 + i, h: 20, d: 5 },
          materials: [pick(['aluminium', 'walnut', 'recycled-abs'] as const, i)],
        }),
        availability: localized(
          locale,
          pick(['in-stock', 'backorder', 'discontinued'] as const, i % 9 === 0 ? 2 : i % 2),
        ),
      },
      patch: { price: localized(locale, 9 + (i % 20) * 10 + 5) },
    };
  });

  // --- articles (the big block; carries taxonomy metadata + all links) ------
  const draftArticleIds: string[] = [];
  const articleIds = await seedGeneratedEntries(run, 'article', 'title', vol.articles, (i) => {
    const title = `${pick(WORDS.verbs, i)} ${pick(WORDS.topics, i)} — part ${Math.floor(i / WORDS.topics.length) + 1}`;
    const status = statusFor(i);
    const withMeta = i % 10 === 1;
    return {
      matchValue: title,
      status,
      metadata: withMeta
        ? {
            tags: [pick(taxonomy.tagIds, i), pick(taxonomy.tagIds, i + 3)],
            concepts: [pick(taxonomy.conceptIds, i)],
          }
        : undefined,
      fields: {
        title: localized(
          locale,
          title,
          hasDe && i % 3 === 0 ? { 'de-DE': `${title} (DE)` } : undefined,
        ),
        body: localized(
          locale,
          `${pick(WORDS.adjectives, i)} guidance on ${pick(WORDS.topics, i)}. ` +
            `Covers ${pick(WORDS.topics, i + 1)} and ${pick(WORDS.topics, i + 2)} in depth.`,
        ),
        summary: localized(locale, `Field notes on ${pick(WORDS.topics, i)}.`),
        author: localized(locale, entryLink(pick(authorIds, i))),
        views: localized(locale, (i * 137) % 5000),
        featured: localized(locale, i % 6 === 0),
        publishedDate: localized(
          locale,
          `2026-0${(i % 6) + 1}-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
        ),
        keywords: localized(locale, [pick(WORDS.topics, i), pick(WORDS.topics, i + 4)]),
        ...(asset(i) ? { heroImage: localized(locale, asset(i)) } : {}),
        category: localized(locale, entryLink(pick(categoryIds, i))),
        readingTime: localized(locale, (i % 25) + 2),
      },
      patch: {
        summary: localized(locale, `Updated field notes on ${pick(WORDS.topics, i)} (v2).`),
      },
    };
  });
  for (let i = 0; i < vol.articles; i++) {
    if (statusFor(i) === 'draft' && articleIds[i]) draftArticleIds.push(articleIds[i]!);
  }

  // --- events ---------------------------------------------------------------
  await seedGeneratedEntries(run, 'event', 'title', vol.events, (i) => {
    const title = `${pick(['Summit', 'Meetup', 'Workshop', 'Webinar'] as const, i)}: ${pick(WORDS.topics, i)} ${i}`;
    return {
      matchValue: title,
      status: statusFor(i),
      fields: {
        title: localized(locale, title),
        startDate: localized(
          locale,
          `2026-1${i % 2}-${String((i % 27) + 1).padStart(2, '0')}T18:00:00.000Z`,
        ),
        endDate: localized(
          locale,
          `2026-1${i % 2}-${String((i % 27) + 1).padStart(2, '0')}T21:00:00.000Z`,
        ),
        venue: localized(locale, {
          lat: 37.77 + (i % 10) * 0.5,
          lon: -122.42 + (i % 10) * 0.7,
        }),
        capacity: localized(locale, 50 + (i % 20) * 25),
        status: localized(
          locale,
          pick(['scheduled', 'sold-out', 'cancelled'] as const, i % 11 === 0 ? 2 : i % 2),
        ),
        speakers: localized(locale, [
          entryLink(pick(authorIds, i)),
          entryLink(pick(authorIds, i + 5)),
        ]),
      },
      patch: { capacity: localized(locale, 50 + (i % 20) * 25 + 10) },
    };
  });

  // --- recipes --------------------------------------------------------------
  await seedGeneratedEntries(run, 'recipe', 'name', vol.recipes, (i) => {
    const name = `${pick(['Roasted', 'Charred', 'Braised', 'Fresh'] as const, i)} ${pick(['squash', 'salmon', 'greens', 'noodles', 'flatbread'] as const, i)} No. ${i}`;
    return {
      matchValue: name,
      status: statusFor(i),
      fields: {
        name: localized(locale, name),
        instructions: localized(
          locale,
          richTextDoc(`Prepare the ${name.toLowerCase()} in three steps.`),
        ),
        nutrition: localized(locale, { calories: 180 + (i % 12) * 40, protein: 6 + (i % 9) }),
        servings: localized(locale, (i % 6) + 2),
        relatedProducts: localized(locale, [entryLink(pick(productIds, i))]),
      },
      patch: { servings: localized(locale, (i % 6) + 4) },
    };
  });

  // --- curated pages (stable) + generated filler ----------------------------
  const pageSeeds = [
    { title: 'Home', slug: 'home', body: 'Welcome to the demo site.' },
    { title: 'About us', slug: 'about', body: 'contentworker is an API-first headless CMS.' },
    { title: 'Documentation', slug: 'docs', body: 'See docs/ in the repository.' },
  ] as const;
  const pageIds: string[] = [];
  for (const p of pageSeeds) {
    const result = await ensurePublishedEntry(run, 'page', 'title', p.title, {
      title: localized(
        locale,
        p.title,
        hasDe && p.title === 'Home' ? { 'de-DE': 'Startseite' } : undefined,
      ),
      slug: localized(locale, p.slug),
      body: localized(locale, richTextDoc(p.body)),
      seoDescription: localized(locale, `${p.title} — seeded for local development.`),
    });
    pageIds.push(result.id);
  }
  const generatedPages = await seedGeneratedEntries(run, 'page', 'title', vol.pages, (i) => {
    const title = `${pick(WORDS.adjectives, i)} ${pick(WORDS.topics, i)} guide`;
    return {
      matchValue: title,
      status: statusFor(i),
      fields: {
        title: localized(locale, title),
        slug: localized(locale, `guide-${i}`),
        body: localized(locale, richTextDoc(`Long-form guide on ${pick(WORDS.topics, i)}.`)),
        seoDescription: localized(locale, `Guide #${i}.`),
      },
      patch: { seoDescription: localized(locale, `Guide #${i} (revised).`) },
    };
  });
  pageIds.push(...generatedPages);

  // --- landing pages (kitchen-sink rich text on the first one) --------------
  await seedGeneratedEntries(run, 'landingPage', 'title', vol.landingPages, (i) => {
    const title = i === 0 ? 'Everything showcase' : `${pick(WORDS.adjectives, i)} launch ${i}`;
    const body =
      i === 0 && articleIds[1] && assetIds[0]
        ? richTextKitchenSink(articleIds[1], assetIds[0])
        : richTextDoc(`Landing page ${i} hero copy.`);
    return {
      matchValue: title,
      status: i === 0 ? 'published' : statusFor(i),
      fields: {
        title: localized(locale, title),
        slug: localized(locale, i === 0 ? 'showcase' : `launch-${i}`),
        body: localized(locale, body),
        sections: localized(locale, [
          entryLink(pick(articleIds, i * 2 + 1)),
          entryLink(pick(pageIds, i)),
        ]),
        ...(asset(i) ? { hero: localized(locale, asset(i)) } : {}),
      },
      patch: {},
    };
  });

  logger.info(
    { articles: vol.articles, products: vol.products, events: vol.events, recipes: vol.recipes },
    'seed: corpus ensured',
  );
  return { articleIds, productIds, draftArticleIds };
}
