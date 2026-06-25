import type { EntryFields, Scope } from '@cw/domain';
import type { EmbeddingsProvider, VectorRow, VectorStore } from '@cw/ports';

export interface RagDeps {
  readonly embeddings: EmbeddingsProvider;
  readonly vectors: VectorStore;
}

/** Collects the human-readable string values of an entry, grouped by locale. */
export function extractTextByLocale(fields: EntryFields): Record<string, string> {
  const byLocale: Record<string, string[]> = {};
  for (const localized of Object.values(fields)) {
    for (const [locale, value] of Object.entries(localized)) {
      if (typeof value === 'string' && value.trim()) {
        const bucket = byLocale[locale] ?? [];
        bucket.push(value);
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
