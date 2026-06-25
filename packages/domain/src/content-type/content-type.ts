import { ConflictError, ValidationError } from '../errors.js';
import type { ContentTypeStatus } from '../types.js';
import { type FieldDefinition, isValidApiId } from './field.js';

/**
 * A content type: the schema for a class of entries. Definitions are versioned
 * and environment-scoped (carried by the repository, not the entity itself).
 */
export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  /** apiId of the field used as the entry's display title. */
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  readonly version: number;
  readonly status: ContentTypeStatus;
}

export interface ContentTypeDraft {
  apiId: string;
  name: string;
  displayField: string;
  fields: FieldDefinition[];
}

/**
 * Validates a content type definition for internal consistency and returns a
 * normalized `ContentType` at version 1, status "draft". Throws on invalid
 * input so callers never persist a malformed schema.
 */
export function defineContentType(draft: ContentTypeDraft): ContentType {
  if (!isValidApiId(draft.apiId)) {
    throw new ValidationError([
      { field: 'apiId', message: `Invalid content type apiId "${draft.apiId}"` },
    ]);
  }
  assertFieldsValid(draft.fields, draft.displayField);
  return {
    apiId: draft.apiId,
    name: draft.name,
    displayField: draft.displayField,
    fields: [...draft.fields].sort((a, b) => a.position - b.position),
    version: 1,
    status: 'draft',
  };
}

/** Produces the next version of a content type from an edited field set. */
export function reviseContentType(
  current: ContentType,
  changes: Partial<Pick<ContentTypeDraft, 'name' | 'displayField' | 'fields'>>,
): ContentType {
  const fields = changes.fields ?? [...current.fields];
  const displayField = changes.displayField ?? current.displayField;
  assertFieldsValid(fields, displayField);
  return {
    ...current,
    name: changes.name ?? current.name,
    displayField,
    fields: [...fields].sort((a, b) => a.position - b.position),
    version: current.version + 1,
    status: 'draft',
  };
}

function assertFieldsValid(fields: readonly FieldDefinition[], displayField: string): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!isValidApiId(f.apiId)) {
      throw new ValidationError([{ field: f.apiId, message: `Invalid field apiId "${f.apiId}"` }]);
    }
    if (seen.has(f.apiId)) {
      throw new ConflictError(`Duplicate field apiId "${f.apiId}"`);
    }
    seen.add(f.apiId);
  }
  if (fields.length > 0 && !seen.has(displayField)) {
    throw new ValidationError([
      { field: 'displayField', message: `displayField "${displayField}" is not a defined field` },
    ]);
  }
}
