import type { ContentType } from '../content-type/content-type.js';
import {
  type FieldDefinition,
  type FieldValidations,
  unsafeRegexReason,
} from '../content-type/field.js';
import { type FieldIssue, ValidationError } from '../errors.js';
import { validateRichText } from '../rich-text/rich-text.js';
import type { EntryFields, LocaleCode } from '../types.js';

export interface ValidationContext {
  readonly defaultLocale: LocaleCode;
  /** Locale codes permitted in the space. */
  readonly locales: readonly LocaleCode[];
}

/** Max serialized size of a single JSON field value (per locale). */
const MAX_JSON_FIELD_BYTES = 256 * 1024;

/**
 * Validates a full set of entry field values against a content type. Returns
 * the issues found (empty when valid). This is the single source of truth used
 * by both human API writes and AI-generated content, so an agent can never
 * produce an entry a human couldn't.
 */
export function validateEntryFields(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const definedByApiId = new Map(contentType.fields.map((f) => [f.apiId, f]));

  // Reject values for fields not in the schema.
  for (const apiId of Object.keys(fields)) {
    if (!definedByApiId.has(apiId)) {
      issues.push({ field: apiId, message: `Unknown field "${apiId}"` });
    }
  }

  for (const field of contentType.fields) {
    const localized = fields[field.apiId] ?? {};
    const targetLocales = field.localized ? ctx.locales : [ctx.defaultLocale];

    for (const locale of targetLocales) {
      const value = localized[locale];
      if (value === undefined || value === null) {
        // Required is enforced on the default locale only; other locales are
        // optional and resolve via the fallback chain at delivery time.
        if (field.required && locale === ctx.defaultLocale) {
          issues.push({ field: field.apiId, locale, message: 'Field is required' });
        }
        continue;
      }
      validateValue(field, value, locale, issues);
    }

    // A non-localized field must not carry values under non-default locales.
    if (!field.localized) {
      for (const locale of Object.keys(localized)) {
        if (locale !== ctx.defaultLocale) {
          issues.push({
            field: field.apiId,
            locale,
            message: 'Field is not localized; only the default locale is allowed',
          });
        }
      }
    }
  }

  return issues;
}

/** Convenience wrapper that throws a ValidationError when issues exist. */
export function assertEntryFieldsValid(
  contentType: ContentType,
  fields: EntryFields,
  ctx: ValidationContext,
): void {
  const issues = validateEntryFields(contentType, fields, ctx);
  if (issues.length > 0) throw new ValidationError(issues);
}

function validateValue(
  field: FieldDefinition,
  value: unknown,
  locale: LocaleCode,
  issues: FieldIssue[],
): void {
  const push = (message: string): void => {
    issues.push({ field: field.apiId, locale, message });
  };
  const v = field.validations;

  switch (field.type) {
    case 'Symbol':
    case 'Text': {
      if (typeof value !== 'string') {
        push('Expected a string');
        return;
      }
      checkSize(value.length, v?.size, push, 'length');
      checkIn(value, v, push);
      if (v?.regexp) {
        // Defence in depth: patterns are screened at content-type authoring time
        // (unsafeRegexReason), but a bad/unsafe pattern here must surface as a
        // validation issue, never an uncaught 500.
        const reason = unsafeRegexReason(v.regexp.pattern, v.regexp.flags);
        if (reason) {
          push(`Invalid pattern: ${reason}`);
        } else if (!new RegExp(v.regexp.pattern, v.regexp.flags).test(value)) {
          push(`Does not match pattern /${v.regexp.pattern}/`);
        }
      }
      break;
    }
    case 'Integer':
    case 'Number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        push('Expected a number');
        return;
      }
      if (field.type === 'Integer' && !Number.isInteger(value)) push('Expected an integer');
      checkRange(value, v?.range, push);
      checkIn(value, v, push);
      break;
    }
    case 'Boolean':
      if (typeof value !== 'boolean') push('Expected a boolean');
      break;
    case 'Date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        push('Expected an ISO-8601 date string');
      }
      break;
    case 'Location': {
      const loc = value as { lat?: unknown; lon?: unknown };
      if (typeof loc?.lat !== 'number' || typeof loc?.lon !== 'number') {
        push('Expected { lat: number, lon: number }');
      }
      break;
    }
    case 'JSON': {
      if (typeof value !== 'object' || value === null) {
        push('Expected a JSON object');
        break;
      }
      // Cap the serialized size so a single field can't store an unbounded blob.
      try {
        if (JSON.stringify(value).length > MAX_JSON_FIELD_BYTES) {
          push(`JSON value exceeds ${MAX_JSON_FIELD_BYTES} bytes`);
        }
      } catch {
        push('JSON value is not serializable');
      }
      break;
    }
    case 'RichText': {
      for (const issue of validateRichText(value)) push(issue);
      break;
    }
    case 'Link':
      if (!isLink(value)) push('Expected a link { id, linkType }');
      break;
    case 'Array': {
      if (!Array.isArray(value)) {
        push('Expected an array');
        return;
      }
      checkSize(value.length, v?.size, push, 'item count');
      const itemType = field.items?.type;
      for (const item of value) {
        if (itemType === 'Link' && !isLink(item))
          push('Array item must be a link { id, linkType }');
        if (itemType === 'Symbol' && typeof item !== 'string') push('Array item must be a string');
      }
      break;
    }
  }
}

function isLink(value: unknown): value is { id: string; linkType: string } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && typeof l?.linkType === 'string';
}

function checkIn(
  value: string | number,
  v: FieldValidations | undefined,
  push: (m: string) => void,
) {
  if (v?.in && !v.in.includes(value)) push(`Value must be one of: ${v.in.join(', ')}`);
}

function checkRange(value: number, range: FieldValidations['range'], push: (m: string) => void) {
  if (range?.min !== undefined && value < range.min) push(`Must be >= ${range.min}`);
  if (range?.max !== undefined && value > range.max) push(`Must be <= ${range.max}`);
}

function checkSize(
  n: number,
  size: FieldValidations['size'],
  push: (m: string) => void,
  label: string,
) {
  if (size?.min !== undefined && n < size.min) push(`${label} must be >= ${size.min}`);
  if (size?.max !== undefined && n > size.max) push(`${label} must be <= ${size.max}`);
}
