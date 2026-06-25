import { NotFoundError } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  updateWebhook,
} from '../src/index.js';

const scope = { spaceId: 'shop', environmentId: 'master' };

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
}

describe('webhook management', () => {
  it('creates, updates (partial), toggles, and deletes a webhook', async () => {
    const c = ctx();
    const created = await createWebhook(c, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });
    expect(created.active).toBe(true);

    // Partial update leaves untouched fields intact.
    const updated = await updateWebhook(c, scope, created.id, {
      topics: ['*'],
      active: false,
    });
    expect(updated.topics).toEqual(['*']);
    expect(updated.active).toBe(false);
    expect(updated.url).toBe('https://hook.example/cw');
    expect(updated.secret).toBe('s3cr3t');

    // Delete removes it from the list.
    await deleteWebhook(c, scope, created.id);
    expect(await listWebhooks(c, scope)).toHaveLength(0);
  });

  it('404s on update/delete of an unknown (or foreign-space) webhook', async () => {
    const c = ctx();
    await expect(updateWebhook(c, scope, 'nope', { active: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteWebhook(c, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
