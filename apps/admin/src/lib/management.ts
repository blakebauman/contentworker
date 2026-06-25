import type { Asset, ContentType, ContentTypeDraft, EntryFields, ReferenceEdge } from '@cw/domain';

/** Connection settings for the Management/Preview APIs (a CMA or admin token). */
export interface Connection {
  readonly baseUrl: string;
  readonly token: string;
  readonly space: string;
  readonly environment: string;
  /** Locale edited in the MVP single-locale form. */
  readonly locale: string;
}

export interface EntryAggregate {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
}

/** Preview view of an entry (current/draft version). */
export interface PreviewEntry {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

export interface EntryView {
  readonly entry: EntryAggregate;
  readonly fields: EntryFields;
}

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/** Space configuration — drives the localization tabs in the editor. */
export interface SpaceConfig {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly fallbacks?: Readonly<Record<string, string | null>>;
}

/** A published entry as served by the Delivery API (locale-collapsed, links embedded). */
export interface DeliveredEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
}

export interface AgentRun {
  readonly id: string;
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

export interface UsageSummary {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/** AI model tier — callers pick a tier, the backend maps it to a concrete model. */
export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** Result of an AI draft: localized field values + token usage. */
export interface GeneratedDraft {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** An API key as listed (the raw token is never returned after creation). */
export interface ApiKeySummary {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes: string[];
  readonly revoked: boolean;
}

/** The one-time result of minting a key — `token` is shown once, never again. */
export interface CreatedApiKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly token: string;
}

/** Event topics a webhook can subscribe to ("*" matches everything). */
export const WEBHOOK_TOPICS = [
  '*',
  'entry.published',
  'entry.unpublished',
  'content_type.published',
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export interface WebhookSummary {
  readonly id: string;
  readonly url: string;
  readonly topics: readonly WebhookTopic[];
  readonly active: boolean;
}

/** A recorded webhook delivery attempt. */
export interface WebhookDeliveryRecord {
  readonly id: number;
  readonly webhookId: string;
  readonly eventId: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  readonly attempts: number;
  readonly error?: string;
  readonly createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Typed client for the Management + Preview APIs. The admin uses one CMA/admin
 * token (CMA keys carry preview:read, so the same token lists drafts and writes
 * content). Management routes author/publish; Preview routes list drafts.
 */
export function createManagementClient(conn: Connection, fetchImpl: typeof fetch = fetch) {
  const root = conn.baseUrl.replace(/\/$/, '');
  const spaceBase = `${root}/spaces/${conn.space}`;
  const mgmt = `${root}/spaces/${conn.space}/environments/${conn.environment}`;
  const preview = `${root}/preview/${conn.space}/${conn.environment}`;
  const delivery = `${root}/delivery/${conn.space}/${conn.environment}`;
  const headers = { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' };

  async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `${method} ${url} → ${res.status} ${text}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  return {
    getSpaceConfig(): Promise<SpaceConfig> {
      return req('GET', `${mgmt}/space-config`);
    },
    /** Environments (branches) in the current space. */
    async listEnvironments(): Promise<Environment[]> {
      const r = await req<{ items: Environment[] }>('GET', `${spaceBase}/environments`);
      return r.items;
    },
    createEnvironment(input: { id: string; name?: string }): Promise<{ id: string }> {
      return req('POST', `${spaceBase}/environments`, input);
    },
    async listContentTypes(): Promise<ContentType[]> {
      const r = await req<{ items: ContentType[] }>('GET', `${mgmt}/content-types`);
      return r.items;
    },
    getContentType(apiId: string): Promise<ContentType> {
      return req('GET', `${mgmt}/content-types/${apiId}`);
    },
    /** Create or update a content type (the route is idempotent on apiId). */
    saveContentType(draft: ContentTypeDraft): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types`, draft);
    },
    publishContentType(apiId: string): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types/${apiId}/published`);
    },
    async listEntries(contentType?: string): Promise<PreviewEntry[]> {
      const qs = contentType ? `?content_type=${encodeURIComponent(contentType)}` : '';
      const r = await req<{ items: PreviewEntry[] }>('GET', `${preview}/entries${qs}`);
      return r.items;
    },
    getEntry(id: string): Promise<PreviewEntry> {
      return req('GET', `${preview}/entries/${encodeURIComponent(id)}`);
    },
    /** Entries/assets that reference this entry ("what links here"). */
    async reverseReferences(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/reverse-references`,
      );
      return r.items;
    },
    /** Reads the published (delivery) version of an entry, rendered for the connection locale. */
    getPublished(id: string): Promise<DeliveredEntry> {
      return req(
        'GET',
        `${delivery}/entries/${encodeURIComponent(id)}?locale=${encodeURIComponent(conn.locale)}`,
      );
    },
    /** `fields` is the localized shape: `{ field: { locale: value } }`. */
    createEntry(contentTypeApiId: string, fields: EntryFields): Promise<EntryView> {
      return req('POST', `${mgmt}/entries`, { contentTypeApiId, fields });
    },
    updateEntry(id: string, fields: EntryFields): Promise<EntryView> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(id)}`, { fields });
    },
    publishEntry(id: string): Promise<EntryAggregate> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    unpublishEntry(id: string): Promise<EntryAggregate> {
      return req('DELETE', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    /** AI-draft field values for a content type from a natural-language prompt. */
    generateEntry(input: {
      contentTypeApiId: string;
      prompt: string;
      tier?: ModelTier;
    }): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/generate`, input);
    },

    // --- assets ----------------------------------------------------------
    async listAssets(): Promise<Asset[]> {
      const r = await req<{ items: Asset[] }>('GET', `${mgmt}/assets`);
      return r.items;
    },
    createAsset(input: { fileName: string; contentType: string; title?: string }): Promise<{
      asset: Asset;
      upload: { url: string; headers: Record<string, string> };
    }> {
      const title = input.title ? { [conn.locale]: input.title } : undefined;
      return req('POST', `${mgmt}/assets`, {
        fileName: input.fileName,
        contentType: input.contentType,
        title,
      });
    },
    publishAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    unpublishAsset(id: string): Promise<Asset> {
      return req('DELETE', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    /**
     * Full upload: create the draft asset (gets a presigned PUT), upload the
     * bytes directly to storage, then publish. Returns the published asset.
     */
    async uploadAsset(file: File): Promise<Asset> {
      const { asset, upload } = await this.createAsset({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        title: file.name,
      });
      const put = await fetchImpl(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: file,
      });
      if (!put.ok) throw new ApiError(put.status, `upload failed: ${put.status}`);
      return this.publishAsset(asset.id);
    },

    // --- dashboards ------------------------------------------------------
    async listAgentRuns(): Promise<AgentRun[]> {
      const r = await req<{ items: AgentRun[] }>('GET', `${mgmt}/agent-runs`);
      return r.items;
    },
    agentUsage(): Promise<UsageSummary> {
      return req('GET', `${mgmt}/agent-runs/usage`);
    },
    async search(query: string): Promise<SearchHit[]> {
      const r = await req<{ hits: SearchHit[] }>(
        'GET',
        `${delivery}/search?q=${encodeURIComponent(query)}`,
      );
      return r.hits;
    },

    // --- settings: API keys (space-scoped) -------------------------------
    async listApiKeys(): Promise<ApiKeySummary[]> {
      const r = await req<{ items: ApiKeySummary[] }>('GET', `${spaceBase}/api-keys`);
      return r.items;
    },
    /** Mints a key; the returned `token` is shown once and never retrievable again. */
    createApiKey(input: { kind: ApiKeyKind; name?: string }): Promise<CreatedApiKey> {
      return req('POST', `${spaceBase}/api-keys`, input);
    },
    revokeApiKey(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: webhooks (environment-scoped) -------------------------
    async listWebhooks(): Promise<WebhookSummary[]> {
      const r = await req<{ items: WebhookSummary[] }>('GET', `${mgmt}/webhooks`);
      return r.items;
    },
    createWebhook(input: {
      url: string;
      topics: readonly WebhookTopic[];
      secret: string;
      active?: boolean;
    }): Promise<WebhookSummary> {
      return req('POST', `${mgmt}/webhooks`, input);
    },
    /** Partial update; omitted fields are left untouched (e.g. just toggle `active`). */
    updateWebhook(
      id: string,
      changes: {
        url?: string;
        topics?: readonly WebhookTopic[];
        secret?: string;
        active?: boolean;
      },
    ): Promise<WebhookSummary> {
      return req('PUT', `${mgmt}/webhooks/${encodeURIComponent(id)}`, changes);
    },
    deleteWebhook(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/webhooks/${encodeURIComponent(id)}`);
    },
    /** Recent delivery attempts for a webhook, newest first. */
    async webhookDeliveries(id: string, limit?: number): Promise<WebhookDeliveryRecord[]> {
      const qs = limit ? `?limit=${limit}` : '';
      const r = await req<{ items: WebhookDeliveryRecord[] }>(
        'GET',
        `${mgmt}/webhooks/${encodeURIComponent(id)}/deliveries${qs}`,
      );
      return r.items;
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
