import type {
  Asset,
  AssetMetadata,
  Comment,
  Concept,
  ConceptScheme,
  ContentType,
  ContentTypeDraft,
  EntryFields,
  EntryMetadata,
  EntryVersion,
  EntryWorkflowState,
  FilterOp,
  ReferenceEdge,
  Release,
  ReleaseItem,
  ReleaseWithItems,
  ScheduledAction,
  ScheduledActionType,
  ScheduledEntityType,
  Tag,
  Task,
  WorkflowDefinition,
  WorkflowStep,
} from '@cw/domain';

/** Connection settings for the Management/Preview APIs (a CMA or admin token). */
export type PersistMode = 'local' | 'session';

export interface Connection {
  readonly baseUrl: string;
  readonly token: string;
  readonly space: string;
  readonly environment: string;
  /** Locale edited in the MVP single-locale form. */
  readonly locale: string;
  /** Where the bearer token is stored between visits. */
  readonly persistMode?: PersistMode;
}

/** Resolved principal from GET /auth/me. */
export interface PrincipalInfo {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted?: boolean;
}

export interface ManagementClientOptions {
  /** Called when any request returns 401 — typically clears credentials and redirects. */
  readonly onUnauthorized?: () => void;
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

/** One field-level predicate. `field` is a content field apiId or a `sys.*`
 *  pseudo-field (e.g. `sys.status`); the client adds the `fields.` namespace. */
export interface EntryFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value?: string | readonly string[] | boolean;
}

/** A sort key over a content field apiId or a `sys.*` pseudo-field. */
export interface EntryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** Query options for the entries list (filters/order/search). */
export interface EntryListQuery {
  readonly filters?: readonly EntryFilter[];
  readonly order?: readonly EntryOrder[];
  readonly search?: string;
  readonly limit?: number;
  readonly skip?: number;
}

/** Namespaces a field path for the query string: `sys.*` stays, else `fields.*`. */
function fieldPath(field: string): string {
  return field.startsWith('sys.') || field.startsWith('metadata.') ? field : `fields.${field}`;
}

/** Serializes an `EntryListQuery` into field-level query params. */
export function entryQueryParams(query: EntryListQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of query.filters ?? []) {
    const path = fieldPath(f.field);
    const key = f.op === 'eq' ? path : `${path}[${f.op}]`;
    const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
    params.set(key, value);
  }
  if (query.order?.length) {
    params.set(
      'order',
      query.order.map((o) => `${o.direction === 'desc' ? '-' : ''}${fieldPath(o.field)}`).join(','),
    );
  }
  if (query.search) params.set('query', query.search);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.skip != null) params.set('skip', String(query.skip));
  return params;
}

/** A space the principal can access (id + display name). */
export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/** A repointable pointer to a target environment (blue/green serving). */
export interface EnvironmentAlias {
  readonly alias: string;
  readonly targetEnvironmentId: string;
  readonly updatedAt: string;
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
  readonly roleId?: string;
  readonly lastUsedAt?: string;
}

/** Custom role (granular RBAC). */
export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants: readonly {
    contentTypeApiId: string;
    actions: readonly ('read' | 'write' | 'publish')[];
    deniedFields?: readonly string[];
    readOnlyFields?: readonly string[];
  }[];
}

export interface PreviewLinkResult {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
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

/** A single field's difference between two entry versions. */
export interface FieldChange {
  readonly field: string;
  readonly kind: 'added' | 'removed' | 'changed' | 'unchanged';
  readonly before: unknown;
  readonly after: unknown;
}

/** Field-by-field diff of two entry versions (from → to). */
export interface VersionDiff {
  readonly entryId: string;
  readonly from: number;
  readonly to: number;
  readonly changes: readonly FieldChange[];
}

/** How a source-environment item relates to the target. */
export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** A diff of two environments (what merging source→target would change). */
export interface EnvironmentComparison {
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly { apiId: string; kind: ChangeKind }[];
  readonly entries: readonly { entryId: string; contentTypeApiId: string; kind: ChangeKind }[];
}

export interface MergeResult {
  readonly mergedContentTypes: readonly string[];
  readonly mergedEntries: readonly string[];
}

export interface AuditEntry {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId?: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly status: number;
  readonly at: string;
}

/** A persisted, templated AI Action. */
export interface AIAction {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly promptTemplate: string;
  readonly variables: readonly string[];
  readonly targetField?: string;
  readonly tier: ModelTier;
  readonly createdAt: string;
}

/** A user-defined function invoked over HTTP on matching domain events. */
export interface FunctionDefinition {
  readonly id: string;
  readonly name: string;
  readonly eventPattern: string;
  readonly url: string;
  readonly active: boolean;
  readonly createdAt: string;
}

/** An admin UI extension rendered in a sandboxed iframe. */
export interface AppExtension {
  readonly id: string;
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  readonly entryUrl: string;
  readonly fieldTypes?: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

/** A requested image transformation (query-param URL convention). */
export interface ImageTransform {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: 'clip' | 'crop' | 'fill' | 'max' | 'scale';
  readonly format?: 'jpg' | 'png' | 'webp' | 'avif';
  readonly quality?: number;
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
export function createManagementClient(
  conn: Connection,
  fetchImpl: typeof fetch = fetch,
  options: ManagementClientOptions = {},
) {
  const root = conn.baseUrl.replace(/\/$/, '');
  const spaceBase = `${root}/spaces/${conn.space}`;
  const mgmt = `${root}/spaces/${conn.space}/environments/${conn.environment}`;
  const preview = `${root}/preview/${conn.space}/${conn.environment}`;
  const delivery = `${root}/delivery/${conn.space}/${conn.environment}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (conn.token.trim()) headers.authorization = `Bearer ${conn.token}`;

  async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(url, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) options.onUnauthorized?.();
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `${method} ${url} → ${res.status} ${text}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  return {
    getPrincipal(): Promise<PrincipalInfo> {
      return req('GET', `${root}/auth/me`);
    },
    getSpaceConfig(): Promise<SpaceConfig> {
      return req('GET', `${mgmt}/space-config`);
    },
    /** Spaces the current token can reach (admin → all; a scoped key → its own). */
    async listSpaces(): Promise<SpaceRef[]> {
      const r = await req<{ items: SpaceRef[] }>('GET', `${root}/spaces`);
      return r.items;
    },
    /** Provision a new space (requires the admin token). */
    createSpace(input: {
      spaceId: string;
      name: string;
      defaultLocale: string;
      locales?: string[];
    }): Promise<SpaceRef> {
      return req('POST', `${root}/spaces`, input);
    },
    /** Environments (branches) in the current space. */
    async listEnvironments(): Promise<Environment[]> {
      const r = await req<{ items: Environment[] }>('GET', `${spaceBase}/environments`);
      return r.items;
    },
    createEnvironment(input: { id: string; name?: string }): Promise<{ id: string }> {
      return req('POST', `${spaceBase}/environments`, input);
    },
    /** Environment aliases (repointable blue/green pointers) in the current space. */
    async listEnvironmentAliases(): Promise<EnvironmentAlias[]> {
      const r = await req<{ items: EnvironmentAlias[] }>('GET', `${spaceBase}/environment-aliases`);
      return r.items;
    },
    /** Creates or atomically repoints an alias at a target environment. */
    setEnvironmentAlias(alias: string, targetEnvironmentId: string): Promise<EnvironmentAlias> {
      return req('PUT', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`, {
        targetEnvironmentId,
      });
    },
    deleteEnvironmentAlias(alias: string): Promise<void> {
      return req('DELETE', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`);
    },
    /** Diffs two environments (content types + entries that differ). */
    compareEnvironments(source: string, target: string): Promise<EnvironmentComparison> {
      return req(
        'GET',
        `${spaceBase}/compare?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      );
    },
    /** Applies selected content types/entries from source→target (additive). */
    mergeEnvironments(input: {
      source: string;
      target: string;
      contentTypes?: string[];
      entries?: string[];
    }): Promise<MergeResult> {
      return req('POST', `${spaceBase}/merge`, input);
    },
    /** Reads the space's append-only audit trail, newest first (requires space:admin). */
    async listAuditLog(
      query: { environment?: string; limit?: number } = {},
    ): Promise<AuditEntry[]> {
      const params = new URLSearchParams();
      if (query.environment) params.set('environment', query.environment);
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      const r = await req<{ items: AuditEntry[] }>(
        'GET',
        `${spaceBase}/audit-log${qs ? `?${qs}` : ''}`,
      );
      return r.items;
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
    /** Lists draft/current entries (Preview API), with optional field filters,
     *  ordering, and full-text search applied server-side. */
    async listEntries(contentType?: string, query: EntryListQuery = {}): Promise<PreviewEntry[]> {
      const params = entryQueryParams(query);
      if (contentType) params.set('content_type', contentType);
      const qs = params.toString();
      const r = await req<{ items: PreviewEntry[] }>(
        'GET',
        `${preview}/entries${qs ? `?${qs}` : ''}`,
      );
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
    /** Map free-form prose into a content type's structured fields (Canvas authoring). */
    canvasEntry(input: {
      contentTypeApiId: string;
      prose: string;
      tier?: ModelTier;
    }): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/canvas`, input);
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
    /** Updates an asset's editorial metadata (alt text, focal point, tags, custom fields). */
    setAssetMetadata(id: string, patch: Partial<AssetMetadata>): Promise<Asset> {
      return req('PATCH', `${mgmt}/assets/${encodeURIComponent(id)}/metadata`, patch);
    },
    /** Lists the entries that reference an asset (where it is used). */
    async assetUsage(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/assets/${encodeURIComponent(id)}/usage`,
      );
      return r.items;
    },
    // --- content semantics (vector-backed) -------------------------------
    /** Entries semantically related to a given entry. */
    async relatedEntries(id: string, topK?: number): Promise<SearchHit[]> {
      const qs = topK ? `?top_k=${topK}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/related${qs}`,
      );
      return r.items;
    },
    /** Near-duplicate entries for a given entry (high similarity). */
    async findDuplicates(id: string, threshold?: number): Promise<SearchHit[]> {
      const qs = threshold ? `?threshold=${threshold}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/duplicates${qs}`,
      );
      return r.items;
    },

    // --- AI Actions (templated, governed) --------------------------------
    async listAIActions(): Promise<AIAction[]> {
      const r = await req<{ items: AIAction[] }>('GET', `${mgmt}/ai-actions`);
      return r.items;
    },
    createAIAction(input: {
      name: string;
      promptTemplate: string;
      description?: string;
      targetField?: string;
      tier?: ModelTier;
    }): Promise<AIAction> {
      return req('POST', `${mgmt}/ai-actions`, input);
    },
    deleteAIAction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/ai-actions/${encodeURIComponent(id)}`);
    },
    runAIAction(
      id: string,
      input: {
        entryId?: string;
        variables?: Record<string, string>;
        locale?: string;
        apply?: boolean;
      } = {},
    ): Promise<{ actionId: string; output: string; applied: boolean }> {
      return req('POST', `${mgmt}/ai-actions/${encodeURIComponent(id)}/run`, input);
    },

    // --- functions (event-triggered) -------------------------------------
    async listFunctions(): Promise<FunctionDefinition[]> {
      const r = await req<{ items: FunctionDefinition[] }>('GET', `${mgmt}/functions`);
      return r.items;
    },
    createFunction(input: {
      name: string;
      eventPattern: string;
      url: string;
      active?: boolean;
    }): Promise<FunctionDefinition> {
      return req('POST', `${mgmt}/functions`, input);
    },
    deleteFunction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/functions/${encodeURIComponent(id)}`);
    },

    // --- app extensions (UI extensions) ----------------------------------
    async listAppExtensions(): Promise<AppExtension[]> {
      const r = await req<{ items: AppExtension[] }>('GET', `${mgmt}/app-extensions`);
      return r.items;
    },
    createAppExtension(input: {
      name: string;
      target: 'field-editor' | 'sidebar';
      entryUrl: string;
      fieldTypes?: string[];
      active?: boolean;
    }): Promise<AppExtension> {
      return req('POST', `${mgmt}/app-extensions`, input);
    },
    deleteAppExtension(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/app-extensions/${encodeURIComponent(id)}`);
    },

    // --- Live Content API (SSE) ------------------------------------------
    /**
     * Subscribes to the Live Content API, invoking `onEvent` per published-content
     * change until `signal` aborts. Uses fetch streaming (EventSource can't send
     * the bearer token); keepalive `ping` frames are filtered out.
     */
    async subscribeLive(
      onEvent: (e: { type: string; data: unknown }) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const res = await fetchImpl(`${delivery}/live`, { headers, signal });
      if (!res.ok || !res.body) throw new ApiError(res.status, `live failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          let type = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (type === 'ping' || !data) continue;
          try {
            onEvent({ type, data: JSON.parse(data) });
          } catch {
            onEvent({ type, data });
          }
        }
      }
    },

    // --- bulk operations -------------------------------------------------
    /** Publishes or unpublishes many entries in one call; failures are per-item. */
    bulkEntryAction(
      action: 'publish' | 'unpublish',
      ids: string[],
    ): Promise<{
      total: number;
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; error?: string }[];
    }> {
      return req('POST', `${mgmt}/bulk/entries/${action}`, { ids });
    },

    // --- agent actions (audit → work packages) ---------------------------
    auditEntry(
      id: string,
      input: {
        createTasks?: boolean;
        taskSeverity?: 'info' | 'warning' | 'error';
        assignee?: string;
      } = {},
    ): Promise<{
      findings: {
        field?: string;
        severity: 'info' | 'warning' | 'error';
        message: string;
        suggestedAction: string;
      }[];
      taskIds: string[];
    }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/audit`, input);
    },

    // --- AI content operations over an entry -----------------------------
    /** Translates an entry's localized text fields; `apply` saves a draft. */
    translateEntry(
      id: string,
      input: { targetLocale: string; sourceLocale?: string; apply?: boolean },
    ): Promise<{ fields: EntryFields; translatedFields: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/translate`, input);
    },
    /** Summarizes an entry; `apply` writes the summary into `targetField`. */
    summarizeEntry(
      id: string,
      input: { locale?: string; maxWords?: number; targetField?: string; apply?: boolean } = {},
    ): Promise<{ summary: string; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/summarize`, input);
    },
    /** Generates a value for one scalar field; `apply` saves it. */
    autofillField(
      id: string,
      input: { field: string; locale?: string; instructions?: string; apply?: boolean },
    ): Promise<{ field: string; value: unknown; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/autofill`, input);
    },
    /** Suggests taxonomy tags for an entry; `apply` creates + assigns them. */
    suggestEntryTags(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/suggest-tags`, input);
    },
    /** Persists a reviewed tag suggestion exactly as approved (no model re-run). */
    applyEntryTags(
      id: string,
      input: { tagIds?: string[]; newTags?: string[] },
    ): Promise<{ tagIds: string[]; createdTags: { id: string; name: string }[] }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/apply-tags`, input);
    },
    /** Suggests alt text for an image; `apply` writes it to the asset metadata. */
    generateAltText(
      id: string,
      input: { locale?: string; context?: string; apply?: boolean } = {},
    ): Promise<{ altText: string; locale: string; applied: boolean }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/alt-text`, input);
    },
    /** Suggests taxonomy tags for an image; `apply` creates + assigns them. */
    autoTagAsset(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/auto-tag`, input);
    },
    /** Resolves a transformed-image URL for an asset (focal-point-aware). */
    transformAsset(
      id: string,
      transform: ImageTransform,
    ): Promise<{ url: string; transform: ImageTransform }> {
      const params = new URLSearchParams();
      if (transform.width) params.set('w', String(transform.width));
      if (transform.height) params.set('h', String(transform.height));
      if (transform.fit) params.set('fit', transform.fit);
      if (transform.format) params.set('fm', transform.format);
      if (transform.quality != null) params.set('q', String(transform.quality));
      const qs = params.toString();
      return req('GET', `${mgmt}/assets/${encodeURIComponent(id)}/transform${qs ? `?${qs}` : ''}`);
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
    createApiKey(input: {
      kind: ApiKeyKind;
      name?: string;
      roleId?: string;
    }): Promise<CreatedApiKey> {
      return req('POST', `${spaceBase}/api-keys`, input);
    },
    revokeApiKey(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: roles (space-scoped) ----------------------------------
    async listRoles(): Promise<RoleSummary[]> {
      const r = await req<{ items: RoleSummary[] }>('GET', `${spaceBase}/roles`);
      return r.items;
    },
    createRole(input: Omit<RoleSummary, 'id'> & { name: string }): Promise<RoleSummary> {
      return req('POST', `${spaceBase}/roles`, input);
    },
    updateRole(id: string, input: Partial<RoleSummary>): Promise<RoleSummary> {
      return req('PUT', `${spaceBase}/roles/${encodeURIComponent(id)}`, input);
    },
    deleteRole(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/roles/${encodeURIComponent(id)}`);
    },

    /** Expiring shareable preview URL for an entry. */
    createPreviewLink(
      entryId: string,
      input?: { ttlHours?: number; previewBaseUrl?: string },
    ): Promise<PreviewLinkResult> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/preview-link`,
        input ?? {},
      );
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

    // --- releases (bundled atomic publish) -------------------------------
    async listReleases(): Promise<Release[]> {
      const r = await req<{ items: Release[] }>('GET', `${mgmt}/releases`);
      return r.items;
    },
    createRelease(input: { title: string; description?: string }): Promise<Release> {
      return req('POST', `${mgmt}/releases`, input);
    },
    getRelease(id: string): Promise<ReleaseWithItems> {
      return req('GET', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    deleteRelease(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    addEntryToRelease(
      id: string,
      input: { entityId: string; action?: ReleaseItem['action'] },
    ): Promise<ReleaseWithItems> {
      return req('POST', `${mgmt}/releases/${encodeURIComponent(id)}/items`, input);
    },
    removeEntryFromRelease(id: string, entityId: string): Promise<ReleaseWithItems> {
      return req(
        'DELETE',
        `${mgmt}/releases/${encodeURIComponent(id)}/items/${encodeURIComponent(entityId)}`,
      );
    },
    /** Ships the bundle — every member publishes/unpublishes in one transaction. */
    publishRelease(id: string): Promise<ReleaseWithItems> {
      return req('POST', `${mgmt}/releases/${encodeURIComponent(id)}/published`);
    },

    // --- scheduled actions -----------------------------------------------
    async listScheduledActions(status?: string): Promise<ScheduledAction[]> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await req<{ items: ScheduledAction[] }>('GET', `${mgmt}/scheduled-actions${qs}`);
      return r.items;
    },
    /** Schedules a publish/unpublish of an entry or release at a future instant. */
    scheduleAction(input: {
      action: ScheduledActionType;
      entityType: ScheduledEntityType;
      entityId: string;
      scheduledFor: string;
    }): Promise<ScheduledAction> {
      return req('POST', `${mgmt}/scheduled-actions`, input);
    },
    cancelScheduledAction(id: string): Promise<ScheduledAction> {
      return req('DELETE', `${mgmt}/scheduled-actions/${encodeURIComponent(id)}`);
    },

    // --- comments (threaded, on entries) ---------------------------------
    async listComments(entryId: string): Promise<Comment[]> {
      const r = await req<{ items: Comment[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`,
      );
      return r.items;
    },
    addComment(
      entryId: string,
      input: { body: string; parentId?: string | null; author?: string },
    ): Promise<Comment> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`, input);
    },
    deleteComment(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/comments/${encodeURIComponent(id)}`);
    },

    // --- tasks (on entries) ----------------------------------------------
    async listTasks(entryId: string): Promise<Task[]> {
      const r = await req<{ items: Task[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`,
      );
      return r.items;
    },
    createTask(entryId: string, input: { body: string; assignee?: string }): Promise<Task> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`, input);
    },
    /** One change per call: status ('resolved'|'open') or reassignment. */
    updateTask(
      id: string,
      change: { status: 'resolved' | 'open' } | { assignee: string | null },
    ): Promise<Task> {
      return req('PUT', `${mgmt}/tasks/${encodeURIComponent(id)}`, change);
    },
    deleteTask(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/tasks/${encodeURIComponent(id)}`);
    },

    // --- workflows (configurable editorial steps) ------------------------
    async listWorkflows(): Promise<WorkflowDefinition[]> {
      const r = await req<{ items: WorkflowDefinition[] }>('GET', `${mgmt}/workflows`);
      return r.items;
    },
    defineWorkflow(input: { name: string; steps: WorkflowStep[] }): Promise<WorkflowDefinition> {
      return req('POST', `${mgmt}/workflows`, input);
    },
    deleteWorkflow(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/workflows/${encodeURIComponent(id)}`);
    },
    /** The entry's current workflow step, or null if it hasn't entered one. */
    getEntryWorkflowState(entryId: string): Promise<EntryWorkflowState | null> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow`);
    },
    /** Moves the entry into a step; the backend enforces the step's required scope. */
    transitionEntry(
      entryId: string,
      input: { workflowId: string; toStepId: string },
    ): Promise<EntryWorkflowState> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow/transition`,
        input,
      );
    },

    // --- taxonomy: concept schemes ---------------------------------------
    async listSchemes(): Promise<ConceptScheme[]> {
      const r = await req<{ items: ConceptScheme[] }>('GET', `${mgmt}/taxonomy/schemes`);
      return r.items;
    },
    createScheme(input: { name: string }): Promise<ConceptScheme> {
      return req('POST', `${mgmt}/taxonomy/schemes`, input);
    },
    deleteScheme(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/schemes/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: concepts (hierarchical) -------------------------------
    async listConcepts(schemeId?: string): Promise<Concept[]> {
      const qs = schemeId ? `?scheme=${encodeURIComponent(schemeId)}` : '';
      const r = await req<{ items: Concept[] }>('GET', `${mgmt}/taxonomy/concepts${qs}`);
      return r.items;
    },
    createConcept(input: {
      schemeId: string;
      prefLabel: string;
      broaderId?: string | null;
    }): Promise<Concept> {
      return req('POST', `${mgmt}/taxonomy/concepts`, input);
    },
    setConceptBroader(id: string, broaderId: string | null): Promise<Concept> {
      return req('PUT', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}/broader`, {
        broaderId,
      });
    },
    deleteConcept(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: tags --------------------------------------------------
    async listTags(): Promise<Tag[]> {
      const r = await req<{ items: Tag[] }>('GET', `${mgmt}/taxonomy/tags`);
      return r.items;
    },
    createTag(input: { name: string }): Promise<Tag> {
      return req('POST', `${mgmt}/taxonomy/tags`, input);
    },
    deleteTag(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/tags/${encodeURIComponent(id)}`);
    },

    // --- entry taxonomy associations -------------------------------------
    getEntryMetadata(entryId: string): Promise<EntryMetadata> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`);
    },
    setEntryMetadata(
      entryId: string,
      input: { tags?: readonly string[]; concepts?: readonly string[] },
    ): Promise<EntryMetadata> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`, input);
    },

    // --- entry version history -------------------------------------------
    async listVersions(entryId: string): Promise<EntryVersion[]> {
      const r = await req<{ items: EntryVersion[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions`,
      );
      return r.items;
    },
    getVersion(entryId: string, version: number): Promise<EntryVersion> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}`);
    },
    diffVersions(entryId: string, from: number, to: number): Promise<VersionDiff> {
      return req(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/diff?from=${from}&to=${to}`,
      );
    },
    /** Copies an older version's fields into a new draft version. */
    restoreVersion(entryId: string, version: number): Promise<EntryView> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}/restore`,
      );
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
