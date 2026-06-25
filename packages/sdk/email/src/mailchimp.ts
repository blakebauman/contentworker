import { createHash } from 'node:crypto';
import type { EmailCampaign, EmailContact, EspConnector } from './index.js';

export interface MailchimpOptions {
  /** Mailchimp API key (e.g. `abc123-us21`). The `-usXX` suffix selects the DC. */
  readonly apiKey: string;
  /** Default audience/list id for contacts and campaigns. */
  readonly audienceId: string;
  readonly fetch?: typeof fetch;
}

/**
 * Mailchimp Marketing API connector. `upsertContact` PUTs a list member;
 * `sendCampaign` creates a regular campaign, sets its HTML content, and sends it.
 * Auth is HTTP Basic (any username + the API key); the data center is parsed
 * from the key's `-usXX` suffix.
 */
export function createMailchimpConnector(opts: MailchimpOptions): EspConnector {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const dc = opts.apiKey.split('-')[1];
  if (!dc) throw new Error('Invalid Mailchimp API key (missing -usXX data-center suffix)');
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const auth = `Basic ${Buffer.from(`anystring:${opts.apiKey}`).toString('base64')}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Mailchimp ${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  }

  return {
    async upsertContact(contact: EmailContact): Promise<void> {
      const hash = createHash('md5').update(contact.email.toLowerCase()).digest('hex');
      await call('PUT', `/lists/${opts.audienceId}/members/${hash}`, {
        email_address: contact.email,
        status_if_new: 'subscribed',
        merge_fields: contact.mergeFields,
        tags: contact.tags,
      });
    },
    async sendCampaign(campaign: EmailCampaign): Promise<{ id: string }> {
      const created = (await call('POST', '/campaigns', {
        type: 'regular',
        recipients: { list_id: campaign.audienceId ?? opts.audienceId },
        settings: {
          subject_line: campaign.subject,
          from_name: campaign.fromName ?? 'contentworker',
          reply_to: campaign.replyTo ?? 'noreply@example.com',
          title: campaign.subject,
        },
      })) as { id: string };
      await call('PUT', `/campaigns/${created.id}/content`, { html: campaign.html });
      await call('POST', `/campaigns/${created.id}/actions/send`);
      return { id: created.id };
    },
  };
}
