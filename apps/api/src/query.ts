/**
 * Parses Contentful-style query parameters into a port `EntryQuery`. Shared by
 * the Delivery, Preview, and GraphQL surfaces so the query language is identical
 * everywhere.
 *
 * Supported syntax:
 *   - `fields.<apiId>=v`                 → equals
 *   - `fields.<apiId>[op]=v`             → op ∈ ne|in|nin|gt|gte|lt|lte|exists|match
 *   - `sys.publishedAt[gt]=<iso>`        → `sys.*` pseudo-fields
 *   - `order=fields.title,-sys.publishedAt`  → sort keys (`-` = descending)
 *   - `select=fields.title,fields.body`  → projection (field apiIds)
 *   - `query=foo`                        → full-text search over string fields
 *   - `content_type`, `limit`, `skip`, `since`, `locale`  → as before
 */

import type { FilterOp, QueryFilter, QueryOrder } from '@cw/domain';
import type { EntryQuery } from '@cw/ports';

const OPS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'match',
]);

const FILTER_KEY = /^((?:fields|sys)\.[A-Za-z0-9_]+)(?:\[(\w+)\])?$/;

/** Strips the leading `fields.` namespace; leaves `sys.*` keys intact. */
function fieldName(path: string): string {
  return path.startsWith('fields.') ? path.slice('fields.'.length) : path;
}

function toFilter(path: string, op: string, raw: string): QueryFilter | null {
  if (!OPS.has(op)) return null;
  const field = fieldName(path);
  if (op === 'in' || op === 'nin') {
    return { field, op: op as FilterOp, value: raw.split(',').map((s) => s.trim()) };
  }
  if (op === 'exists') {
    return { field, op: 'exists', value: raw !== 'false' };
  }
  return { field, op: op as FilterOp, value: raw };
}

function parseOrder(raw: string): QueryOrder[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const direction = token.startsWith('-') ? 'desc' : 'asc';
      const path = token.replace(/^-/, '');
      return { field: fieldName(path), direction };
    });
}

/** Builds an `EntryQuery` from raw query-string entries (key/value pairs). */
export function entryQueryFrom(entries: Iterable<[string, string]>): EntryQuery {
  const filters: QueryFilter[] = [];
  let order: QueryOrder[] | undefined;
  let select: string[] | undefined;
  let search: string | undefined;
  let contentTypeApiId: string | undefined;
  let limit: number | undefined;
  let skip: number | undefined;
  let since: string | undefined;
  let locale: string | undefined;

  for (const [key, value] of entries) {
    if (key === 'order') {
      order = parseOrder(value);
      continue;
    }
    if (key === 'select') {
      select = value
        .split(',')
        .map((s) => fieldName(s.trim()))
        .filter((s) => s && !s.startsWith('sys.'));
      continue;
    }
    if (key === 'query') {
      search = value;
      continue;
    }
    if (key === 'content_type') {
      contentTypeApiId = value;
      continue;
    }
    if (key === 'limit') {
      limit = Number(value);
      continue;
    }
    if (key === 'skip') {
      skip = Number(value);
      continue;
    }
    if (key === 'since') {
      since = value;
      continue;
    }
    if (key === 'locale') {
      locale = value;
      continue;
    }
    const m = FILTER_KEY.exec(key);
    if (m) {
      const filter = toFilter(m[1] as string, m[2] ?? 'eq', value);
      if (filter) filters.push(filter);
    }
  }

  return {
    contentTypeApiId,
    limit,
    skip,
    since,
    locale,
    filters: filters.length ? filters : undefined,
    order,
    select,
    search,
  };
}

/** Convenience: parse straight from a `URLSearchParams`. */
export function parseEntryQuery(params: URLSearchParams): EntryQuery {
  return entryQueryFrom(params.entries());
}
