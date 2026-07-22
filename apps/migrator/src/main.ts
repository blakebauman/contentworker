import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ensurePgVectorSchema } from '@cw/adapter-vector-pgvector';
import { logger } from '@cw/telemetry';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applies Drizzle migrations. Deployed as a Kubernetes pre-install/pre-upgrade
 * hook Job so the schema is current before app pods roll out.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  // Migrations are generated into the postgres adapter package. Resolve the
  // package itself, not a workspace-relative path — the slim `pnpm deploy`
  // image layout has no packages/ directory (the adapter lives under
  // node_modules there).
  const require = createRequire(import.meta.url);
  const migrationsFolder = resolve(
    dirname(require.resolve('@cw/adapter-store-postgres/package.json')),
    'drizzle',
  );

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  logger.info({ migrationsFolder }, 'running migrations');
  await migrate(db, { migrationsFolder });
  await sql.end();

  // pgvector schema (extension + content_embeddings + HNSW index) is applied
  // here — not at adapter runtime — parameterized by embedding dimension.
  // Set SKIP_PGVECTOR=true for databases without the pgvector extension.
  if (process.env.SKIP_PGVECTOR !== 'true') {
    const dimensions = Number(process.env.EMBEDDINGS_DIM ?? 1536);
    logger.info({ dimensions }, 'applying pgvector schema');
    await ensurePgVectorSchema(url, { dimensions });
  }
  logger.info('migrations complete');
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
