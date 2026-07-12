import type { Scope } from '@cw/domain';
import type { VectorMatch, VectorRow, VectorStore } from '@cw/ports';
import postgres from 'postgres';

export interface PgVectorOptions {
  /** Embedding dimension — fixes the vector column width. Must match the provider. */
  dimensions?: number;
  /** Recorded on each row so an embedding-model swap is detectable. */
  modelId?: string;
}

const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

type Sql = ReturnType<typeof postgres>;

async function runSchemaDdl(sql: Sql, dimensions: number): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`
    CREATE TABLE IF NOT EXISTS content_embeddings (
      space_id text NOT NULL,
      environment_id text NOT NULL,
      entry_id text NOT NULL,
      locale text NOT NULL,
      chunk_index int NOT NULL,
      chunk_text text NOT NULL,
      embedding vector(${sql.unsafe(String(dimensions))}) NOT NULL,
      model_id text NOT NULL,
      dimensions int NOT NULL,
      entry_version int NOT NULL,
      PRIMARY KEY (space_id, environment_id, entry_id, locale, chunk_index)
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS content_embeddings_ann
      ON content_embeddings USING hnsw (embedding vector_cosine_ops)`;
  await sql`
    CREATE INDEX IF NOT EXISTS content_embeddings_scope
      ON content_embeddings (space_id, environment_id, locale)`;
}

/**
 * Applies the pgvector schema (extension, table, HNSW cosine index) as an
 * explicit migration step — run by `@cw/migrator` alongside the Drizzle
 * migrations. Idempotent. Kept out of the request path so the adapter never
 * executes DDL at runtime.
 */
export async function ensurePgVectorSchema(
  connectionString: string,
  opts: PgVectorOptions = {},
): Promise<void> {
  const sql = postgres(connectionString, { max: 1 });
  try {
    await runSchemaDdl(sql, opts.dimensions ?? 1536);
  } finally {
    await sql.end();
  }
}

/**
 * pgvector-backed VectorStore. Schema is applied by the migrator
 * (`ensurePgVectorSchema`); `ensureSchema()` remains for tests/dev bootstraps.
 * Cosine distance via the `<=>` operator; score = 1 - distance.
 */
export function createPgVectorStore(
  connectionString: string,
  opts: PgVectorOptions = {},
): VectorStore & { ensureSchema(): Promise<void>; close(): Promise<void> } {
  const sql = postgres(connectionString);
  const dimensions = opts.dimensions ?? 1536;
  const modelId = opts.modelId ?? 'unknown';
  let ready: Promise<void> | null = null;

  const ensureSchema = (): Promise<void> => {
    ready ??= runSchemaDdl(sql, dimensions);
    return ready;
  };

  return {
    ensureSchema,
    async upsert(rows: VectorRow[]) {
      if (rows.length === 0) return;
      await sql.begin(async (tx) => {
        for (const r of rows) {
          await tx`
            INSERT INTO content_embeddings
              (space_id, environment_id, entry_id, locale, chunk_index, chunk_text, embedding, model_id, dimensions, entry_version)
            VALUES (
              ${r.scope.spaceId}, ${r.scope.environmentId}, ${r.entryId}, ${r.locale}, ${r.chunkIndex},
              ${r.chunkText}, ${toVectorLiteral(r.embedding)}::vector, ${modelId}, ${r.embedding.length}, ${r.entryVersion}
            )
            ON CONFLICT (space_id, environment_id, entry_id, locale, chunk_index) DO UPDATE SET
              chunk_text = EXCLUDED.chunk_text,
              embedding = EXCLUDED.embedding,
              model_id = EXCLUDED.model_id,
              dimensions = EXCLUDED.dimensions,
              entry_version = EXCLUDED.entry_version`;
        }
      });
    },
    async deleteByEntry(scope: Scope, entryId: string) {
      await sql`
        DELETE FROM content_embeddings
        WHERE space_id = ${scope.spaceId} AND environment_id = ${scope.environmentId} AND entry_id = ${entryId}`;
    },
    async query(scope: Scope, embedding: number[], opts2: { topK: number; minScore?: number }) {
      const q = toVectorLiteral(embedding);
      const minScore = opts2.minScore ?? -1;
      const rows = await sql<{ entry_id: string; chunk_text: string; score: number }[]>`
        SELECT entry_id, chunk_text, 1 - (embedding <=> ${q}::vector) AS score
        FROM content_embeddings
        WHERE space_id = ${scope.spaceId} AND environment_id = ${scope.environmentId}
          AND 1 - (embedding <=> ${q}::vector) >= ${minScore}
        ORDER BY embedding <=> ${q}::vector
        LIMIT ${opts2.topK}`;
      return rows.map(
        (r): VectorMatch => ({
          entryId: r.entry_id,
          chunkText: r.chunk_text,
          score: Number(r.score),
        }),
      );
    },
    async close() {
      await sql.end();
    },
  };
}
