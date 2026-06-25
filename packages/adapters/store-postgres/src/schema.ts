import type { AssetFile, DomainEvent, EntryFields, LocalizedValue } from '@cw/domain';
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
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] }),
    index('entry_published_by_type').on(t.spaceId, t.environmentId, t.contentTypeApiId),
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
    name: text('name').notNull(),
    hashedToken: text('hashed_token').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_hashed_token').on(t.hashedToken),
    index('api_keys_by_space').on(t.spaceId),
  ],
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
  (t) => [index('webhook_deliveries_by_webhook').on(t.spaceId, t.webhookId)],
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
  (t) => [index('outbox_pending').on(t.occurredAt).where(sql`${t.relayedAt} IS NULL`)],
);
