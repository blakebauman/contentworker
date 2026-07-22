import { describe, expect, it, vi } from 'vitest';
import { type PgVectorClient, createPgVectorStore } from '../src/index.js';

describe('pgvector pool ownership', () => {
  it('close() ends a client the adapter created from a connection string', async () => {
    const store = createPgVectorStore('postgres://postgres:postgres@localhost:1/never-dialed');
    // postgres.js connects lazily, so ending an unused client is safe.
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() leaves a shared (injected) client alone', async () => {
    const end = vi.fn(async () => {});
    const shared = { end } as unknown as PgVectorClient;
    const store = createPgVectorStore(shared);
    await store.close();
    expect(end).not.toHaveBeenCalled();
  });
});
