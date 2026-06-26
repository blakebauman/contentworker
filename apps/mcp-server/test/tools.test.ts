import { createHash } from 'node:crypto';
import {
  type AppContext,
  createContentType,
  createSpace,
  publishContentType,
} from '@cw/application';
import type { Principal } from '@cw/domain';
import { SCOPES } from '@cw/domain';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@cw/test-kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type { McpDeps } from '../src/wire.js';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

// Stub AI returns schema-shaped values so generate/canvas tools work offline.
function stubAI() {
  return new StubAIProvider((req) => {
    const props =
      (req.outputSchema as { properties?: Record<string, { type?: string }> })?.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      out[key] = def.type === 'integer' || def.type === 'number' ? 1 : `v-${key}`;
    }
    return out;
  });
}

function makeDeps(): McpDeps {
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: stubAI(),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
  };
}

const adminPrincipal: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

/** Connects a Client to a freshly built server for the given principal. */
async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Parses the JSON payload a tool returns via its text content. */
function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? 'null';
  return JSON.parse(text);
}

async function seed(deps: McpDeps) {
  const { ctx } = deps;
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  await publishContentType(ctx, scope, 'article');
}

describe('MCP tools (end-to-end over the in-memory transport)', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await seed(deps);
  });

  it('lists content types', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = await client.callTool({ name: 'model_list_content_types', arguments: {} });
    const types = payload(res) as { apiId: string }[];
    expect(types.map((t) => t.apiId)).toContain('article');
  });

  it('round-trips a function through create → list → delete', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'function_create',
        arguments: { name: 'reindex', eventPattern: 'entry.*', url: 'https://example.com/h' },
      }),
    ) as { id: string };
    const listed = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(listed.map((f) => f.id)).toContain(created.id);

    await client.callTool({ name: 'function_delete', arguments: { id: created.id } });
    const after = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(after.map((f) => f.id)).not.toContain(created.id);
  });

  it('registers a UI extension', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'app_extension_create',
        arguments: { name: 'widget', target: 'sidebar', entryUrl: 'https://example.com/w' },
      }),
    ) as { id: string; target: string };
    expect(created.target).toBe('sidebar');
    const listed = payload(
      await client.callTool({ name: 'app_extensions_list', arguments: {} }),
    ) as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(created.id);
  });

  it('maps prose into structured fields (entry_from_canvas)', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = payload(
      await client.callTool({
        name: 'entry_from_canvas',
        arguments: { contentType: 'article', prose: 'A short story about a title.' },
      }),
    ) as { fields: Record<string, Record<string, unknown>> };
    expect(res.fields.title?.['en-US']).toBe('v-title');
  });

  it('enforces RBAC: a delivery-only principal cannot create a function', async () => {
    const reader: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const client = await connect(deps, reader);
    const res = await client.callTool({
      name: 'function_create',
      arguments: { name: 'x', eventPattern: '*', url: 'https://example.com/h' },
    });
    // The authorize() guard throws; the SDK surfaces it as an error result.
    expect(res.isError).toBe(true);
  });
});
