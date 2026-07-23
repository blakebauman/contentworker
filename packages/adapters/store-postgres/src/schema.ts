import type {
  AssetFile,
  AssetMetadata,
  ContentTypeGrant,
  DomainEvent,
  EntryFields,
  LocalizedValue,
} from '@cw/domain';
import type { FieldDefinition } from '@cw/domain';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema — the only file aware of the physical data model. The domain
 * never imports these types. Content types and entries are environment-scoped
 * (a space holds many environments / branches).
 *
 * For P1, a content type's field definitions are stored as a JSONB column
 * (their natural cohesive, versioned unit). A normalized `fields` table is a
 * later optimization that does not change this adapter's port behavior.
 */

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  defaultLocale: text('default_locale').notNull(),
  locales: jsonb('locales').$type<string[]>().notNull(),
  fallbacks: jsonb('fallbacks').$type<Record<string, string | null>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const environments = pgTable(
  'environments',
  {
    id: text('id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.id] })],
);

/** Repointable pointers to a target environment (blue/green serving). */
export const environmentAliases = pgTable(
  'environment_aliases',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    targetEnvironmentId: text('target_environment_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.alias] })],
);

export const contentTypes = pgTable(
  'content_types',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    apiId: text('api_id').notNull(),
    name: text('name').notNull(),
    displayField: text('display_field').notNull(),
    fields: jsonb('fields').$type<FieldDefinition[]>().notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<'draft' | 'published'>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.apiId] })],
);

export const entries = pgTable(
  'entries',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    status: text('status').$type<'draft' | 'changed' | 'published' | 'archived'>().notNull(),
    currentVersion: integer('current_version').notNull(),
    publishedVersion: integer('published_version'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const entryVersions = pgTable(
  'entry_versions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    version: integer('version').notNull(),
    fields: jsonb('fields').$type<EntryFields>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId, t.version] })],
);

export const entryPublished = pgTable(
  'entry_published',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    version: integer('version').notNull(),
    fields: jsonb('fields').$type<EntryFields>().notNull(),
    metadata: jsonb('metadata').$type<{ tags: string[]; concepts: string[] }>(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] }),
    index('entry_published_by_type').on(t.spaceId, t.environmentId, t.contentTypeApiId),
    // Full-text leg of hybrid search. Expression must match searchPublished's.
    index('entry_published_fts').using(
      'gin',
      sql`jsonb_to_tsvector('simple', ${t.fields}, '["string"]')`,
    ),
  ],
);

export const assets = pgTable(
  'assets',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    status: text('status').$type<'draft' | 'published' | 'archived'>().notNull(),
    file: jsonb('file').$type<AssetFile>().notNull(),
    title: jsonb('title').$type<LocalizedValue>().notNull(),
    description: jsonb('description').$type<LocalizedValue>().notNull(),
    metadata: jsonb('metadata').$type<AssetMetadata>().notNull().default({ altText: {}, tags: [] }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const assetPublished = pgTable(
  'asset_published',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    assetId: text('asset_id').notNull(),
    file: jsonb('file').$type<AssetFile>().notNull(),
    title: jsonb('title').$type<LocalizedValue>().notNull(),
    description: jsonb('description').$type<LocalizedValue>().notNull(),
    metadata: jsonb('metadata').$type<AssetMetadata>().notNull().default({ altText: {}, tags: [] }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.assetId] })],
);

export const references = pgTable(
  'references',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    fromEntryId: text('from_entry_id').notNull(),
    fromField: text('from_field').notNull(),
    toId: text('to_id').notNull(),
    toType: text('to_type').$type<'Entry' | 'Asset'>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.fromEntryId, t.fromField, t.toId] }),
    index('references_reverse').on(t.spaceId, t.environmentId, t.toId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    kind: text('kind').$type<'cma' | 'cda' | 'cpa'>().notNull(),
    // Optional human label; the admin shows "Name (optional)".
    name: text('name'),
    hashedToken: text('hashed_token').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    revoked: boolean('revoked').notNull().default(false),
    // Granular RBAC: when set, permissions resolve live from this role.
    roleId: text('role_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // When set, the key stops authenticating after this instant (e.g. OIDC keys).
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_hashed_token').on(t.hashedToken),
    index('api_keys_by_space').on(t.spaceId),
  ],
);

// Custom roles (granular RBAC): a named scope set plus per-content-type
// grants (with per-field deny/read-only rules), referenced by api_keys.role_id.
export const roles = pgTable(
  'roles',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    contentGrants: jsonb('content_grants').$type<ContentTypeGrant[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.id] })],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    workflow: text('workflow').notNull(),
    entryId: text('entry_id').notNull(),
    status: text('status').notNull(),
    decisions: jsonb('decisions').$type<string[]>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('agent_runs_by_space').on(t.spaceId, t.createdAt)],
);

/** Append-only governance audit trail. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    status: integer('status').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [index('audit_log_by_space').on(t.spaceId, t.at)],
);

/** Persisted, templated AI operations ("AI Actions"), env-scoped. */
export const aiActions = pgTable(
  'ai_actions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    promptTemplate: text('prompt_template').notNull(),
    variables: jsonb('variables').$type<string[]>().notNull(),
    targetField: text('target_field'),
    tier: text('tier').$type<'flagship' | 'balanced' | 'fast'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

/** User-defined functions invoked over HTTP on matching domain events. */
export const functions = pgTable(
  'functions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    eventPattern: text('event_pattern').notNull(),
    url: text('url').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

/** UI extensions the admin renders in a sandboxed iframe (custom field editors / sidebar widgets). */
export const appExtensions = pgTable(
  'app_extensions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    target: text('target').notNull(),
    entryUrl: text('entry_url').notNull(),
    fieldTypes: jsonb('field_types').$type<string[]>(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull(),
  url: text('url').notNull(),
  topics: jsonb('topics').$type<string[]>().notNull(),
  secret: text('secret').notNull(),
  active: boolean('active').notNull().default(true),
  headers: jsonb('headers').$type<Record<string, string>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    spaceId: text('space_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    eventId: text('event_id').notNull(),
    status: text('status').$type<'success' | 'failed'>().notNull(),
    statusCode: integer('status_code'),
    attempts: integer('attempts').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_by_webhook').on(t.spaceId, t.webhookId),
    // Serves the retention sweep (deleteDeliveriesBefore).
    index('webhook_deliveries_by_created').on(t.createdAt),
  ],
);

export const releases = pgTable(
  'releases',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').$type<'open' | 'published' | 'archived'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const releaseItems = pgTable(
  'release_items',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    releaseId: text('release_id').notNull(),
    entityType: text('entity_type').$type<'Entry'>().notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').$type<'publish' | 'unpublish'>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.releaseId, t.entityId] })],
);

export const scheduledActions = pgTable(
  'scheduled_actions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    action: text('action').$type<'publish' | 'unpublish'>().notNull(),
    entityType: text('entity_type').$type<'Entry' | 'Release'>().notNull(),
    entityId: text('entity_id').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: text('status').$type<'pending' | 'completed' | 'canceled' | 'failed'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // The worker scans for pending actions whose time has arrived.
    index('scheduled_actions_due').on(t.status, t.scheduledFor),
  ],
);

export const agentReviews = pgTable(
  'agent_reviews',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    workflow: text('workflow').notNull(),
    entryId: text('entry_id').notNull(),
    proposed: jsonb('proposed').$type<EntryFields>().notNull(),
    notes: jsonb('notes').$type<string[]>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull(),
    awaiting: boolean('awaiting').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // Reviewers list pending reviews per scope, newest first.
    index('agent_reviews_pending').on(t.spaceId, t.environmentId, t.status, t.createdAt),
  ],
);

export const agentSchedules = pgTable(
  'agent_schedules',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    workflow: text('workflow').notNull(),
    contentTypeApiId: text('content_type_api_id'),
    cron: text('cron').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    autoApply: boolean('auto_apply').notNull().default(false),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    cursorEntryId: text('cursor_entry_id'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // The worker scans for enabled schedules whose next run has arrived.
    index('agent_schedules_due').on(t.enabled, t.nextRunAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    entryId: text('entry_id').notNull(),
    parentId: text('parent_id'),
    author: text('author').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('comments_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    entryId: text('entry_id').notNull(),
    assignee: text('assignee'),
    body: text('body').notNull(),
    status: text('status').$type<'open' | 'resolved'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('tasks_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const workflowDefinitions = pgTable(
  'workflow_definitions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    steps: jsonb('steps').$type<{ id: string; name: string; requiredScope: string }[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const entryWorkflowState = pgTable(
  'entry_workflow_state',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    currentStepId: text('current_step_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] })],
);

export const conceptSchemes = pgTable(
  'concept_schemes',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const concepts = pgTable(
  'concepts',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    schemeId: text('scheme_id').notNull(),
    prefLabel: text('pref_label').notNull(),
    broaderId: text('broader_id'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('concepts_by_scheme').on(t.spaceId, t.environmentId, t.schemeId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const entryMetadata = pgTable(
  'entry_metadata',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull(),
    concepts: jsonb('concepts').$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] })],
);

export const previewTokens = pgTable(
  'preview_tokens',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    hashedToken: text('hashed_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('preview_tokens_hashed_token').on(t.hashedToken),
    index('preview_tokens_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<DomainEvent>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_pending').on(t.occurredAt).where(sql`${t.relayedAt} IS NULL`),
    // Serves the retention sweep (deleteRelayedBefore); partial so the hot
    // pending rows never pay for it.
    index('outbox_relayed')
      .on(t.relayedAt)
      .where(sql`${t.relayedAt} IS NOT NULL`),
  ],
);
