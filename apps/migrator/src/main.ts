import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // Migrations are generated into the postgres adapter package.
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../../packages/adapters/store-postgres/drizzle');

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  console.log(`Running migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  await sql.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
