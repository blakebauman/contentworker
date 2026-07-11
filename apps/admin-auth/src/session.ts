import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  readonly subject: string;
  readonly email?: string;
  readonly apiToken: string;
  readonly apiKeyId: string;
  readonly spaceId: string;
  readonly expiresAt: number;
}

const COOKIE = 'cw_admin_session';

export function sessionCookieName(): string {
  return COOKIE;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export function decodeSession(raw: string | undefined, secret: string): SessionPayload | null {
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  try {
    if (
      expected.length !== sig.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
    ) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAgeSec: number, secure: boolean): string {
  const parts = [
    `Max-Age=${maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean);
  return parts.join('; ');
}
