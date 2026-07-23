import type { QueryFilter } from '@cw/domain';
import { type SQL, and, or, sql } from 'drizzle-orm';

/**
 * SQL prefilters for field-level entry queries.
 *
 * The domain engine (`runEntryQuery`) is the single source of truth for query
 * SEMANTICS — locale resolution order, string→field-type coercion, array
 * membership, numeric-vs-lexical comparison. Reproducing all of that in SQL
 * would risk silent divergence on the busiest read path, so this module never
 * tries to. Instead every predicate it emits is a **superset**: it may admit
 * rows the engine will later reject, but it must never exclude a row the
 * engine would have kept. The engine then runs over the (bounded) candidate
 * set and produces the exact answer.
 *
 * That turns "load the entire scoped published set into memory" into "load the
 * rows that could plausibly match", which is the actual scaling problem, while
 * keeping Postgres and the in-memory store bit-identical in behavior.
 *
 * Ops with no superset-safe translation (negations, comparisons on JSON field
 * values whose ordering depends on runtime type) are simply not pushed down —
 * omitting a predicate only widens the candidate set, which is always safe.
 *
 * DEPLOYMENT REQUIREMENT: the substring prefilters use ILIKE, which case-folds
 * via the database's LC_CTYPE, whereas the engine uses JS Unicode folding. On a
 * UTF-8 collation (what we deploy on, Neon included) the two agree, and SQL
 * folding that is merely MORE aggressive stays a superset. On a `C`-collation
 * database ILIKE would not fold non-ASCII at all and could drop a row the
 * engine would keep. The cross-store equivalence suite carries non-ASCII cases
 * precisely so this is caught when contract tests run against a target
 * database — run them before deploying onto a new one.
 */

/** A field value can live under any locale key; these are the jsonb forms a
 *  string comparand could equal once the engine coerces it to the field's type. */
function comparandForms(value: unknown): string[] {
  const forms: unknown[] = [value];
  if (typeof value === 'string') {
    // Mirror domain `coerce` EXACTLY: it converts a string comparand to a
    // number whenever `Number(s)` is not NaN, so both forms must be admitted.
    // The condition must not be "tightened" — `Number('')` is 0, not NaN, so
    // an `eq ''` filter really does match a numeric 0 field in the engine, and
    // skipping that form here would drop the row (a superset violation caught
    // by the adversarial probe in query-equivalence.test.ts).
    const n = Number(value);
    if (!Number.isNaN(n)) forms.push(n);
    if (value === 'true') forms.push(true);
    if (value === 'false') forms.push(false);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    forms.push(String(value));
  }
  return forms.map((v) => JSON.stringify(v));
}

/**
 * Superset predicate for `eq`/`in` on a content field: the field exists and
 * SOME locale's value contains one of the comparand forms. `@>` covers both
 * scalar equality and array membership (`'["a","b"]'::jsonb @> '"a"'`), which
 * mirrors the engine's array-field semantics.
 */
function fieldValueMatches(fieldsCol: SQL, field: string, values: readonly unknown[]): SQL | null {
  const forms = values.flatMap((v) => comparandForms(v));
  if (forms.length === 0) return null;
  const anyForm = or(...forms.map((f) => sql`kv.value @> ${f}::jsonb`));
  // CASE, not AND: SQL does not guarantee AND short-circuits, and jsonb_each
  // raises on a non-object. A malformed/imported field value must widen the
  // scan, never turn the request into a 500.
  return sql`(CASE WHEN jsonb_typeof(${fieldsCol} -> ${field}) = 'object'
    THEN EXISTS (
      SELECT 1 FROM jsonb_each(${fieldsCol} -> ${field}) AS kv WHERE ${anyForm}
    ) ELSE ${fieldsCol} ? ${field} END)`;
}

/**
 * Wraps a literal needle as an ILIKE pattern.
 *
 * `%` and `_` are left unescaped on purpose: as wildcards they only WIDEN the
 * match, and a superset is always safe. A backslash is not — LIKE treats it as
 * an escape, so an unescaped `\` would make the pattern match FEWER rows than
 * the engine's literal substring test and could drop a real result. Doubling it
 * keeps it literal.
 */
function likePattern(needle: string): string {
  return `%${needle.replace(/\\/g, '\\\\')}%`;
}

/**
 * Superset for a case-insensitive substring match on a field: does any LOCALE
 * value of the field contain the needle?
 *
 * Matches the decoded values via `jsonb_each_text`, never the field's `::text`
 * rendering — that rendering is JSON-ENCODED, so a stored `\` appears as `\\`
 * and a stored `"` as `\"`, while the needle carries the raw character. The
 * engine compares against the decoded string, so comparing against JSON text
 * would under-match and silently drop rows.
 */
function fieldTextLike(fieldsCol: SQL, field: string, needle: string): SQL {
  return sql`(CASE WHEN jsonb_typeof(${fieldsCol} -> ${field}) = 'object'
    THEN EXISTS (
      SELECT 1 FROM jsonb_each_text(${fieldsCol} -> ${field}) AS kv
      WHERE kv.value ILIKE ${likePattern(needle)}
    ) ELSE ${fieldsCol} ? ${field} END)`;
}

/** Columns a `sys.*` pseudo-field maps to, when the row has a real column. */
export interface SysColumns {
  readonly entryId: SQL;
  readonly contentTypeApiId: SQL;
  readonly publishedAt?: SQL;
}

/**
 * Builds the superset prefilter for a set of field predicates.
 * Returns null when nothing could be pushed down (caller scans unfiltered).
 */
export function buildFilterPrefilter(
  filters: readonly QueryFilter[],
  fieldsCol: SQL,
  sys: SysColumns,
): SQL | null {
  const conds: SQL[] = [];
  for (const f of filters) {
    // `sys.*`/`metadata.*` resolve from the row's sys record. Only the ones
    // backed by real columns are pushed; metadata arrays stay in JS.
    if (f.field.startsWith('sys.')) {
      const name = f.field.slice(4);
      const col =
        name === 'id'
          ? sys.entryId
          : name === 'contentType'
            ? sys.contentTypeApiId
            : name === 'publishedAt'
              ? sys.publishedAt
              : undefined;
      if (!col) continue;
      if (f.op === 'eq' && typeof f.value === 'string') {
        conds.push(sql`${col} = ${f.value}`);
      } else if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 0) {
        conds.push(or(...f.value.map((v) => sql`${col} = ${String(v)}`)) as SQL);
      }
      // Ranges on sys columns are left to the engine: publishedAt compares as
      // an ISO string there, and a timestamp cast here could disagree at the
      // boundary. Correctness first; these are cheap in JS.
      continue;
    }
    if (f.field.startsWith('metadata.')) continue;

    switch (f.op) {
      case 'eq': {
        const c = fieldValueMatches(fieldsCol, f.field, [f.value]);
        if (c) conds.push(c);
        break;
      }
      case 'in': {
        if (!Array.isArray(f.value) || f.value.length === 0) break;
        const c = fieldValueMatches(fieldsCol, f.field, f.value);
        if (c) conds.push(c);
        break;
      }
      case 'match': {
        if (typeof f.value !== 'string' || f.value === '') break;
        conds.push(fieldTextLike(fieldsCol, f.field, f.value));
        break;
      }
      case 'exists': {
        // Only the positive form is superset-safe: `exists:false` matches rows
        // where the key is absent OR present-but-null, so pushing `NOT ?` could
        // drop the null case.
        const want = f.value === undefined ? true : Boolean(f.value);
        if (want) conds.push(sql`${fieldsCol} ? ${f.field}`);
        break;
      }
      // ne / nin / gt / gte / lt / lte: no superset-safe form (negation can
      // exclude; ordering depends on the field's runtime type). Left to JS.
      default:
        break;
    }
  }
  return conds.length > 0 ? (and(...conds) as SQL) : null;
}

/**
 * Superset for free-text `search`: the engine matches a case-insensitive
 * SUBSTRING of any string field value. Full-text search would tokenize and
 * therefore MISS substrings (`ell` in `hello`), so it cannot be used as a
 * prefilter here — a whole-document ILIKE is the correct superset.
 */
export function buildSearchPrefilter(search: string, fieldsCol: SQL): SQL | null {
  if (!search.trim()) return null;
  // Unnest field → locale → value and test the DECODED text, for the same
  // JSON-escaping reason as fieldTextLike.
  return sql`EXISTS (
    SELECT 1 FROM jsonb_each(${fieldsCol}) AS fld
    WHERE CASE WHEN jsonb_typeof(fld.value) = 'object'
      THEN EXISTS (
        SELECT 1 FROM jsonb_each_text(fld.value) AS kv
        WHERE kv.value ILIKE ${likePattern(search)}
      ) ELSE true END
  )`;
}
