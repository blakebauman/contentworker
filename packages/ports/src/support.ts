/**
 * Small infrastructure ports that keep the application layer deterministic and
 * testable. Adapters bind these at the composition root.
 */

/** Abstracts the wall clock so use-cases and tests are deterministic. */
export interface Clock {
  now(): Date;
}

/** Abstracts identifier generation (UUIDs in production, counters in tests). */
export interface IdGenerator {
  newId(): string;
}

/** One-way hash for API tokens (SHA-256 in production). */
export interface Hasher {
  hash(value: string): string;
}
