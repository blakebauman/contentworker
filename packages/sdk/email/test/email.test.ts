import { describe, expect, it, vi } from 'vitest';
import { createMailchimpConnector, FakeEspConnector, mapEntryToCampaign } from '../src/index.js';

describe('@cw/sdk-email', () => {
  it('maps a delivered entry to a campaign via field roles', () => {
    const fields = { title: 'Spring Sale', body: '<h1>50% off</h1>', other: 'ignored' };
    const c = mapEntryToCampaign(fields, { subjectField: 'title', bodyField: 'body', fromName: 'Shop' });
    expect(c.subject).toBe('Spring Sale');
    expect(c.html).toBe('<h1>50% off</h1>');
    expect(c.fromName).toBe('Shop');
  });

  it('throws when the subject field is empty', () => {
    expect(() => mapEntryToCampaign({ body: 'x' }, { subjectField: 'title', bodyField: 'body' })).toThrow(/Subject/);
  });

  it('pushes campaigns + contacts through a connector (fake)', async () => {
    const esp = new FakeEspConnector();
    const { id } = await esp.sendCampaign({ subject: 'Hi', html: '<p>Hi</p>' });
    expect(id).toBe('fake-campaign-1');
    await esp.upsertContact({ email: 'a@b.com', mergeFields: { FNAME: 'Ada' } });
    expect(esp.campaigns).toHaveLength(1);
    expect(esp.contacts[0]?.email).toBe('a@b.com');
  });

  it('Mailchimp connector creates → sets content → sends, with DC + basic auth', async () => {
    const calls: { method: string; url: string; auth?: string }[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, auth: (init?.headers as Record<string, string>)?.authorization });
      const bodyForPath = url.endsWith('/campaigns') ? { id: 'camp_42' } : {};
      return new Response(JSON.stringify(bodyForPath), { status: 200 });
    }) as unknown as typeof fetch;

    const mc = createMailchimpConnector({ apiKey: 'secret-us21', audienceId: 'list1', fetch: fakeFetch });
    const res = await mc.sendCampaign({ subject: 'Launch', html: '<p>Launch</p>' });
    expect(res.id).toBe('camp_42');

    // DC parsed from the key → us21 host; HTTP Basic auth; 3-step send.
    expect(calls[0]?.url).toBe('https://us21.api.mailchimp.com/3.0/campaigns');
    expect(calls[0]?.auth?.startsWith('Basic ')).toBe(true);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /3.0/campaigns',
      'PUT /3.0/campaigns/camp_42/content',
      'POST /3.0/campaigns/camp_42/actions/send',
    ]);
  });
});
