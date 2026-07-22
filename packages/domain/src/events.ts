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
  | ReleasePublishedEvent
  | SearchReindexRequestedEvent;

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

/**
 * A request to (re)embed every published entry in the scope — a background job,
 * not a state-change fact. Enqueued via the outbox so the expensive work runs on
 * the worker/queue consumer instead of the triggering request.
 */
export interface SearchReindexRequestedEvent extends BaseEvent {
  readonly type: 'search.reindex_requested';
  /** Limit the reindex to one content type, or all when omitted. */
  readonly contentTypeApiId?: string;
  /**
   * Continuation cursor: reindex only entries with `entryId` strictly greater
   * (keyset paging — stable under concurrent publishes/unpublishes). Set only
   * on self-enqueued follow-up slices: the consumer processes a bounded slice
   * per invocation and re-enqueues the remainder, so one queue message never
   * has to fit an entire reindex inside a single invocation's limits.
   */
  readonly afterEntryId?: string;
  /** Entries already processed by earlier slices (bounds the job total). */
  readonly entriesSoFar?: number;
}

export type EventType = DomainEvent['type'];
