import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { wire } from '../src/wire.js';

const config: ApiConfig = {
  role: 'all',
  port: 0,
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: { spaceId: 's1', environmentId: 'main', defaultLocale: 'en-US', locales: ['en-US'] },
} as ApiConfig;

function makeApp() {
  const { ctx, rag, blob, ai, bus } = wire(config);
  return createApp(ctx, config, rag, blob, ai, bus);
}

describe('OpenAPI spec + docs UI', () => {
  it('serves a 3.x spec whose paths cover the mounted surface', async () => {
    const app = makeApp();
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('contentworker API');
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');

    const paths = Object.keys(spec.paths);
    // Full inventory: management + delivery + preview mount >100 routes.
    expect(paths.length).toBeGreaterThan(80);
    expect(paths).toContain('/delivery/{space}/{env}/entries/{id}');
    expect(paths).toContain('/preview/{space}/{env}/entries/{id}');
    expect(paths).toContain('/spaces/{space}/environments/{env}/entries');
    expect(paths).toContain('/auth/me');
    // The spec never documents itself or the UI.
    expect(paths).not.toContain('/openapi.json');
    expect(paths).not.toContain('/docs');
  });

  it('spec reflects ROLE gating (delivery-only deployment has no management paths)', async () => {
    const { ctx, rag, blob, ai, bus } = wire({ ...config, role: 'delivery' });
    const app = createApp(ctx, { ...config, role: 'delivery' }, rag, blob, ai, bus);
    const res = await app.request('/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths.some((p) => p.startsWith('/delivery/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/spaces/'))).toBe(false);
  });

  it('serves the Scalar UI at /docs', async () => {
    const app = makeApp();
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('openapi.json');
  });
});
