import { isRichTextDocument, richTextToPlainText } from '@cw/domain';
import type { EntryFields, Scope } from '@cw/domain';
import type { EmbeddingsProvider, VectorRow, VectorStore } from '@cw/ports';
import type { AppContext } from './context.js';

export interface RagDeps {
  readonly embeddings: EmbeddingsProvider;
  readonly vectors: VectorStore;
}

/** Collects the human-readable string values of an entry, grouped by locale. */
export function extractTextByLocale(fields: EntryFields): Record<string, string> {
  const byLocale: Record<string, string[]> = {};
  for (const localized of Object.values(fields)) {
    for (const [locale, value] of Object.entries(localized)) {
      const text =
        typeof value === 'string'
          ? value
          : isRichTextDocument(value)
            ? richTextToPlainText(value)
            : '';
      if (text.trim()) {
        const bucket = byLocale[locale] ?? [];
        bucket.push(text);
        byLocale[locale] = bucket;
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [locale, parts] of Object.entries(byLocale)) out[locale] = parts.join('\n\n');
  return out;
}

/** Splits text into word-bounded chunks of at most `maxWords` words. */
export function chunk(text: string, maxWords = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

export interface IndexEntryInput {
  readonly entryId: string;
  readonly fields: EntryFields;
  readonly entryVersion: number;
}

/**
 * Embeds an entry's text (per locale, chunked) and upserts the vectors. Existing
 * vectors for the entry are deleted first so a republish replaces stale chunks.
 * Idempotent: re-running with the same input yields the same stored rows.
 */
export async function indexEntryEmbeddings(
  deps: RagDeps,
  scope: Scope,
  input: IndexEntryInput,
): Promise<number> {
  await deps.vectors.deleteByEntry(scope, input.entryId);

  const rows: VectorRow[] = [];
  for (const [locale, text] of Object.entries(extractTextByLocale(input.fields))) {
    const chunks = chunk(text);
    if (chunks.length === 0) continue;
    const embeddings = await deps.embeddings.embed(chunks, { taskType: 'document' });
    chunks.forEach((chunkText, chunkIndex) => {
      rows.push({
        scope,
        entryId: input.entryId,
        locale,
        chunkIndex,
        chunkText,
        embedding: embeddings[chunkIndex] ?? [],
        entryVersion: input.entryVersion,
      });
    });
  }
  if (rows.length > 0) await deps.vectors.upsert(rows);
  return rows.length;
}

export interface ReindexResult {
  /** Published entries re-embedded. */
  readonly entries: number;
  /** Vector rows written (an entry with no extractable text yields none). */
  readonly chunks: number;
}

/**
 * Re-embeds every published entry in the scope (optionally one content type),
 * paging through the read model. Use after a change to text extraction or the
 * embedding model so already-published content becomes searchable without a
 * republish. Each entry reindex is idempotent (stale vectors are replaced).
 */
export async function reindexEmbeddings(
  deps: RagDeps,
  ctx: AppContext,
  scope: Scope,
  opts: { contentTypeApiId?: string; batchSize?: number } = {},
): Promise<ReindexResult> {
  const batchSize = opts.batchSize ?? 100;
  let skip = 0;
  let entries = 0;
  let chunks = 0;
  for (;;) {
    const page = await ctx.store.entries.listPublished(scope, {
      contentTypeApiId: opts.contentTypeApiId,
      limit: batchSize,
      skip,
    });
    for (const published of page) {
      chunks += await indexEntryEmbeddings(deps, scope, {
        entryId: published.entryId,
        fields: published.fields,
        entryVersion: published.version,
      });
      entries += 1;
    }
    if (page.length < batchSize) break;
    skip += batchSize;
  }
  return { entries, chunks };
}

export async function removeEntryEmbeddings(
  deps: RagDeps,
  scope: Scope,
  entryId: string,
): Promise<void> {
  await deps.vectors.deleteByEntry(scope, entryId);
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/**
 * Semantic search: embeds the query and returns the best-matching entries,
 * deduplicated to the highest-scoring chunk per entry.
 */
export async function semanticSearch(
  deps: RagDeps,
  scope: Scope,
  query: string,
  opts: { topK?: number; minScore?: number } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 10;
  // Exclude zero/negative-similarity (orthogonal) matches by default.
  const minScore = opts.minScore ?? 1e-6;
  const [embedding] = await deps.embeddings.embed([query], { taskType: 'query' });
  if (!embedding) return [];
  // Over-fetch chunks, then collapse to best chunk per entry.
  const matches = await deps.vectors.query(scope, embedding, { topK: topK * 4, minScore });
  const best = new Map<string, SearchHit>();
  for (const m of matches) {
    const existing = best.get(m.entryId);
    if (!existing || m.score > existing.score) {
      best.set(m.entryId, { entryId: m.entryId, score: m.score, snippet: m.chunkText });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Reciprocal Rank Fusion constant — the standard default from the RRF paper. */
const RRF_K = 60;

/**
 * Hybrid search: fuses semantic search (vector ANN) with ranked full-text
 * search over the published read model via Reciprocal Rank Fusion. RRF works
 * on ranks, so the legs' incomparable scores (cosine similarity vs. ts_rank)
 * never need calibrating. Pass `deps: undefined` for a lexical-only search
 * (no embeddings configured).
 */
export async function hybridSearch(
  deps: RagDeps | undefined,
  ctx: AppContext,
  scope: Scope,
  query: string,
  opts: { topK?: number } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 10;
  // Over-fetch per leg so a hit ranked just outside topK in both legs can
  // still fuse into the final topK.
  const fetchK = topK * 2;
  const [semantic, lexical] = await Promise.all([
    deps ? semanticSearch(deps, scope, query, { topK: fetchK }) : Promise.resolve([]),
    ctx.store.entries.searchPublished(scope, query, { topK: fetchK }),
  ]);

  const fused = new Map<string, { score: number; snippet?: string }>();
  const add = (entryId: string, rank: number, snippet?: string) => {
    const hit = fused.get(entryId) ?? { score: 0 };
    hit.score += 1 / (RRF_K + rank + 1);
    if (!hit.snippet && snippet) hit.snippet = snippet;
    fused.set(entryId, hit);
  };
  semantic.forEach((hit, rank) => add(hit.entryId, rank, hit.snippet));
  lexical.forEach((hit, rank) => add(hit.entryId, rank));

  const ranked = [...fused.entries()]
    .sort(([aId, a], [bId, b]) => b.score - a.score || aId.localeCompare(bId))
    .slice(0, topK);

  // Lexical-only hits carry no chunk text — derive a snippet from the fields.
  return Promise.all(
    ranked.map(async ([entryId, hit]) => ({
      entryId,
      score: hit.score,
      snippet: hit.snippet ?? (await snippetFor(ctx, scope, entryId, query)),
    })),
  );
}

/** A short excerpt around the first query-term match in the published text. */
async function snippetFor(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  query: string,
): Promise<string> {
  const published = await ctx.store.entries.getPublished(scope, entryId);
  if (!published) return '';
  const text = Object.values(extractTextByLocale(published.fields)).join('\n\n');
  const lower = text.toLowerCase();
  const term = query
    .toLowerCase()
    .split(/\s+/)
    .find((t) => t && lower.includes(t));
  const at = term ? lower.indexOf(term) : 0;
  const start = Math.max(0, at - 60);
  const slice = text.slice(start, start + 180).trim();
  if (!slice) return '';
  const prefix = start > 0 ? '…' : '';
  const suffix = start + 180 < text.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}
