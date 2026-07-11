import { logger, startTelemetry } from '@cw/telemetry';
import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as client from 'openid-client';
import { loadBffConfig, oidcEnabled } from './config.js';
import { mintDelegatedKey, revokeDelegatedKey } from './delegated-key.js';
import { type SessionPayload, decodeSession, encodeSession, sessionCookieName } from './session.js';

startTelemetry('cw-admin-bff');

const config = loadBffConfig();
const app = new Hono();

const pendingStates = new Map<string, { createdAt: number }>();
const pkceVerifiers = new Map<string, string>();
const STATE_TTL_MS = 10 * 60 * 1000;

function purgeStates(): void {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (now - v.createdAt > STATE_TTL_MS) pendingStates.delete(k);
  }
}

let oidcConfig: client.Configuration | null = null;

async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcEnabled(config)) throw new Error('OIDC is not configured');
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(config.oidcIssuer!),
      config.oidcClientId!,
      config.oidcClientSecret!,
    );
  }
  return oidcConfig;
}

function readSession(c: Context): SessionPayload | null {
  return decodeSession(getCookie(c, sessionCookieName()), config.sessionSecret);
}

app.get('/healthz', (c) => c.json({ status: 'ok', oidc: oidcEnabled(config) }));

app.get('/auth/login', async (c) => {
  if (!oidcEnabled(config)) return c.json({ error: 'OIDC not configured' }, 503);
  purgeStates();
  const oidc = await getOidcConfig();
  const state = crypto.randomUUID();
  pendingStates.set(state, { createdAt: Date.now() });
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  pendingStates.set(`${state}:verifier`, { createdAt: Date.now() });
  const authUrl = client.buildAuthorizationUrl(oidc, {
    redirect_uri: config.oidcRedirectUri!,
    scope: 'openid profile email groups',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  pkceVerifiers.set(state, codeVerifier);
  return c.redirect(authUrl.href);
});

app.get('/auth/callback', async (c) => {
  if (!oidcEnabled(config)) return c.json({ error: 'OIDC not configured' }, 503);
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? '';
  if (!pendingStates.has(state)) return c.text('Invalid state', 400);

  const codeVerifier = pkceVerifiers.get(state);
  if (!codeVerifier) return c.text('Missing PKCE verifier', 400);
  pkceVerifiers.delete(state);

  const oidc = await getOidcConfig();
  const tokens = await client.authorizationCodeGrant(oidc, url, {
    expectedState: state,
    pkceCodeVerifier: codeVerifier,
  });
  const claims = tokens.claims();
  const subject = String(claims?.sub ?? '');
  const email = claims?.email ? String(claims.email) : undefined;
  const groups = Array.isArray(claims?.groups)
    ? (claims.groups as string[])
    : typeof claims?.groups === 'string'
      ? [claims.groups]
      : [];

  const { token, keyId } = await mintDelegatedKey(config, subject, groups);
  const expiresAt = Date.now() + config.sessionTtlHours * 60 * 60 * 1000;
  const payload: SessionPayload = {
    subject,
    email,
    apiToken: token,
    apiKeyId: keyId,
    spaceId: config.defaultSpace,
    expiresAt,
  };

  setCookie(c, sessionCookieName(), encodeSession(payload, config.sessionSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: config.sessionTtlHours * 60 * 60,
    path: '/',
  });

  return c.redirect('/');
});

app.get('/auth/me', async (c) => {
  const session = readSession(c);
  if (!session) return c.json({ authenticated: false }, 401);

  const res = await fetch(`${config.apiUrl}/auth/me`, {
    headers: { authorization: `Bearer ${session.apiToken}` },
  });
  if (!res.ok) return c.json({ authenticated: false }, 401);
  const principal = await res.json();
  return c.json({
    authenticated: true,
    subject: session.subject,
    email: session.email,
    spaceId: session.spaceId,
    principal,
  });
});

app.post('/auth/logout', async (c) => {
  const session = readSession(c);
  if (session) {
    await revokeDelegatedKey(config, session.apiKeyId).catch(() => {});
  }
  deleteCookie(c, sessionCookieName(), { path: '/' });
  return c.body(null, 204);
});

/** Reverse-proxy Management/Delivery/Preview API with the session bearer injected. */
app.all('/api/*', async (c) => {
  const session = readSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const targetPath = c.req.path.replace(/^\/api/, '');
  const target = `${config.apiUrl}${targetPath}${c.req.url.includes('?') ? `?${new URL(c.req.url).searchParams}` : ''}`;

  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'host' || key.toLowerCase() === 'cookie') return;
    headers.set(key, value);
  });
  headers.set('authorization', `Bearer ${session.apiToken}`);

  const res = await fetch(target, {
    method: c.req.method,
    headers,
    body:
      c.req.method === 'GET' || c.req.method === 'HEAD'
        ? undefined
        : await c.req.raw.clone().arrayBuffer(),
    redirect: 'manual',
  });

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    { port: info.port, oidc: oidcEnabled(config), api: config.apiUrl },
    'contentworker admin-bff listening',
  );
});
