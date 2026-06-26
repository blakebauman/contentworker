import type { EntryFields, Scope } from './types.js';

/**
 * Domain events. These are appended to the transactional outbox within the same
 * transaction as the state change, then relayed to the event bus / queue. Every
 * event carries a stable `id` so downstream handlers can be idempotent.
 */
export type DomainEvent =
  | EntryPublishedEvent
  | EntryUnpublishedEvent
  | ContentTypePublishedEvent
  | ReleasePublishedEvent;

export interface BaseEvent {
  readonly id: string;
  readonly scope: Scope;
  readonly occurredAt: string;
}

export interface EntryPublishedEvent extends BaseEvent {
  readonly type: 'entry.published';
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly fields: EntryFields;
}

export interface EntryUnpublishedEvent extends BaseEvent {
  readonly type: 'entry.unpublished';
  readonly entryId: string;
  readonly contentTypeApiId: string;
}

export interface ContentTypePublishedEvent extends BaseEvent {
  readonly type: 'content_type.published';
  readonly contentTypeApiId: string;
  readonly version: number;
}

/** Emitted when a release ships. Per-member entry events are emitted separately
 *  in the same transaction, so this is a summary for webhooks/audit. */
export interface ReleasePublishedEvent extends BaseEvent {
  readonly type: 'release.published';
  readonly releaseId: string;
  readonly entryIds: readonly string[];
}

export type EventType = DomainEvent['type'];
