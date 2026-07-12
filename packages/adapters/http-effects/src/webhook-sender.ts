import { createHmac } from 'node:crypto';
import type { DomainEvent, Webhook } from '@cw/domain';
import type { WebhookSendResult, WebhookSender } from '@cw/ports';

/**
 * HMAC-signing webhook sender. Posts the event as JSON with an
 * `X-CW-Signature: sha256=<hex>` header so receivers can verify authenticity,
 * plus a timestamp to bound replay. Network/HTTP errors surface as
 * `delivered: false` so the queue can retry.
 *
 * Uses `node:crypto` — available on Node and on Cloudflare Workers via the
 * `nodejs_compat` compatibility flag.
 */
export function createWebhookSender(fetchImpl: typeof fetch = fetch): WebhookSender {
  return {
    async send(webhook: Webhook, payload: DomainEvent): Promise<WebhookSendResult> {
      const body = JSON.stringify(payload);
      const timestamp = payload.occurredAt;
      const signature = createHmac('sha256', webhook.secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      try {
        const res = await fetchImpl(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cw-signature': `sha256=${signature}`,
            'x-cw-timestamp': timestamp,
            'x-cw-event': payload.type,
            ...webhook.headers,
          },
          body,
        });
        return { delivered: res.ok, statusCode: res.status };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
