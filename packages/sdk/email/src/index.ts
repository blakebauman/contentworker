/**
 * @cw/sdk-email — push structured contentworker content into email service
 * providers (Mailchimp-style). An `EspConnector` port with a Mailchimp adapter
 * and a recording fake; `mapEntryToCampaign` renders a delivered entry's fields
 * into a campaign via a field→role mapping. Server-side (uses an ESP API key) —
 * drive it from the repurpose agent or a Management-API action.
 */

export interface EmailCampaign {
  readonly subject: string;
  readonly html: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly audienceId?: string;
}

export interface EmailContact {
  readonly email: string;
  readonly mergeFields?: Record<string, string>;
  readonly tags?: string[];
}

export interface EspConnector {
  /** Create + send a campaign. Returns the provider's campaign id. */
  sendCampaign(campaign: EmailCampaign): Promise<{ id: string }>;
  /** Create or update a contact/subscriber. */
  upsertContact(contact: EmailContact): Promise<void>;
}

/** Maps a delivered entry's (locale-flattened) fields to a campaign. */
export interface CampaignMapping {
  readonly subjectField: string;
  readonly bodyField: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly audienceId?: string;
}

export function mapEntryToCampaign(
  fields: Record<string, unknown>,
  mapping: CampaignMapping,
): EmailCampaign {
  const subject = String(fields[mapping.subjectField] ?? '');
  const html = String(fields[mapping.bodyField] ?? '');
  if (!subject) throw new Error(`Subject field "${mapping.subjectField}" is empty`);
  return {
    subject,
    html,
    fromName: mapping.fromName,
    replyTo: mapping.replyTo,
    audienceId: mapping.audienceId,
  };
}

/** A connector that records calls instead of hitting an ESP — for tests/dev. */
export class FakeEspConnector implements EspConnector {
  readonly campaigns: EmailCampaign[] = [];
  readonly contacts: EmailContact[] = [];
  private n = 0;
  async sendCampaign(campaign: EmailCampaign): Promise<{ id: string }> {
    this.campaigns.push(campaign);
    this.n += 1;
    return { id: `fake-campaign-${this.n}` };
  }
  async upsertContact(contact: EmailContact): Promise<void> {
    this.contacts.push(contact);
  }
}

export { createMailchimpConnector, type MailchimpOptions } from './mailchimp.js';
