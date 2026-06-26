import type { DomainEvent } from '@cw/domain';
import type { FunctionInvoker } from '@cw/ports';

/**
 * HTTP function invoker. POSTs the triggering event as JSON to the function's
 * URL; network/HTTP errors surface as `ok: false` (logged, never fatal).
 */
export function createHttpFunctionInvoker(fetchImpl: typeof fetch = fetch): FunctionInvoker {
  return {
    async invoke(url: string, event: DomainEvent) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cw-event': event.type },
          body: JSON.stringify(event),
        });
        return { ok: res.ok, statusCode: res.status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
