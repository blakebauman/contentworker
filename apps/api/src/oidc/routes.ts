import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as client from 'openid-client';
import type { AuthDeps } from '../auth.js';
import type { ApiConfig } from '../config.js';
import { mintDelegatedKey, revokeDelegatedKey } from './delegated-key.js';
import { type SessionPayload, decodeSession, encodeSession, sessionCookieName } from './session.js';
import { oidcEnabled, oidcSettingsFromConfig } from './settings.js';

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

function readSession(c: Context, secret: string): SessionPayload | null {
  return decodeSession(getCookie(c, sessionCookieName()), secret);
}

/** Admin OIDC login routes — mounted on the Management API (no bearer required). */
export function oidcRoutes(deps: AuthDeps, config: ApiConfig): Hono {
  const settings = oidcSettingsFromConfig(config);
  const app = new Hono();

  async function getOidcConfig(): Promise<client.Configuration> {
    if (!oidcEnabled(settings)) throw new Error('OIDC is not configured');
    if (!oidcConfig) {
      oidcConfig = await client.discovery(
        new URL(settings.issuer!),
        settings.clientId!,
        settings.clientSecret!,
      );
    }
    return oidcConfig;
  }

  app.get('/auth/oidc/login', async (c) => {
    if (!oidcEnabled(settings)) return c.json({ error: 'OIDC not configured' }, 503);
    purgeStates();
    const oidc = await getOidcConfig();
    const state = crypto.randomUUID();
    pendingStates.set(state, { createdAt: Date.now() });
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const authUrl = client.buildAuthorizationUrl(oidc, {
      redirect_uri: settings.redirectUri!,
      scope: 'openid profile email groups',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    pkceVerifiers.set(state, codeVerifier);
    return c.redirect(authUrl.href);
  });

  app.get('/auth/oidc/callback', async (c) => {
    if (!oidcEnabled(settings)) return c.json({ error: 'OIDC not configured' }, 503);
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state') ?? '';
    if (!pendingStates.has(state)) return c.text('Invalid state', 400);

    const codeVerifier = pkceVerifiers.get(state);
    if (!codeVerifier) return c.text('Missing PKCE verifier', 400);
    pkceVerifiers.delete(state);
    pendingStates.delete(state);

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

    const { token, keyId } = await mintDelegatedKey(
      deps.ctx,
      deps.hasher,
      settings,
      subject,
      groups,
    );
    const expiresAt = Date.now() + settings.sessionTtlHours * 60 * 60 * 1000;
    const payload: SessionPayload = {
      subject,
      email,
      apiToken: token,
      apiKeyId: keyId,
      spaceId: settings.defaultSpace,
      expiresAt,
    };

    setCookie(c, sessionCookieName(), encodeSession(payload, settings.sessionSecret), {
      httpOnly: true,
      // Derive Secure from the request scheme (works on Cloudflare, where
      // NODE_ENV is never "production") and force it on under REQUIRE_SECURE_SECRETS.
      secure:
        new URL(c.req.url).protocol === 'https:' ||
        process.env.REQUIRE_SECURE_SECRETS === 'true' ||
        process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: settings.sessionTtlHours * 60 * 60,
      path: '/',
    });

    return c.redirect(settings.adminUiUrl);
  });

  app.post('/auth/logout', async (c) => {
    const session = readSession(c, settings.sessionSecret);
    if (session) {
      await revokeDelegatedKey(deps.ctx, settings, session.apiKeyId).catch(() => {});
    }
    deleteCookie(c, sessionCookieName(), { path: '/' });
    return c.body(null, 204);
  });

  return app;
}
