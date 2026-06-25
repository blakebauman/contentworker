import { ConflictError, DomainError, NotFoundError, ValidationError } from '@cw/domain';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** Maps a domain error onto an HTTP status code + JSON body. */
export function toHttpError(err: unknown): { status: number; body: unknown } {
  if (err instanceof NotFoundError) return { status: 404, body: errBody(err) };
  if (err instanceof ValidationError) {
    return {
      status: 422,
      body: { error: { code: err.code, message: err.message, issues: err.issues } },
    };
  }
  if (err instanceof ConflictError) return { status: 409, body: errBody(err) };
  if (err instanceof DomainError && err.code === 'unauthorized')
    return { status: 401, body: errBody(err) };
  if (err instanceof DomainError && err.code === 'forbidden')
    return { status: 403, body: errBody(err) };
  if (err instanceof DomainError) return { status: 400, body: errBody(err) };
  if (err instanceof HTTPException) {
    return { status: err.status, body: { error: { code: 'http_error', message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
}

function errBody(err: DomainError) {
  return { error: { code: err.code, message: err.message } };
}

/** Central error handler registered via `app.onError`. */
export function onError(err: unknown, c: Context) {
  const { status, body } = toHttpError(err);
  // biome-ignore lint/suspicious/noExplicitAny: hono status code typing
  return c.json(body as any, status as any);
}
