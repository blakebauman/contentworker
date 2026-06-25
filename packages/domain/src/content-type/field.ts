/**
 * Field definitions for content types. These mirror the structured-content
 * model: a content type is an ordered list of typed, validated fields.
 */

export const FIELD_TYPES = [
  'Symbol', // short text (single line)
  'Text', // long text (multi line)
  'RichText', // structured rich text document
  'Integer',
  'Number',
  'Boolean',
  'Date', // ISO-8601 string
  'Location', // { lat, lon }
  'JSON', // arbitrary JSON object
  'Link', // reference to another entry or asset
  'Array', // array of Symbols or Links
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** What a Link (or Array of Links) points at. */
export type LinkType = 'Entry' | 'Asset';

/**
 * Validation rules for a field. All optional; an absent rule is not enforced.
 * Stored as JSON on the field definition.
 */
export interface FieldValidations {
  /** Allowed values (enumeration). */
  in?: readonly (string | number)[];
  /** Regular expression a Symbol/Text value must match. */
  regexp?: { pattern: string; flags?: string };
  /** Numeric range (inclusive) for Integer/Number. */
  range?: { min?: number; max?: number };
  /** Length range (inclusive) for Symbol/Text, or item count for Array. */
  size?: { min?: number; max?: number };
  /** For Link/Array-of-Link: restrict to these content type apiIds. */
  linkContentTypes?: readonly string[];
}

export interface FieldDefinition {
  /** Stable machine identifier, unique within the content type. */
  readonly apiId: string;
  /** Human-facing name. */
  readonly name: string;
  readonly type: FieldType;
  /** Whether values may differ per locale. */
  readonly localized: boolean;
  readonly required: boolean;
  /** Ordering within the content type (ascending). */
  readonly position: number;
  readonly validations?: FieldValidations;
  /** For Link fields: whether it links an Entry or Asset. */
  readonly linkType?: LinkType;
  /** For Array fields: the element definition. */
  readonly items?: {
    readonly type: Extract<FieldType, 'Symbol' | 'Link'>;
    readonly linkType?: LinkType;
    readonly validations?: FieldValidations;
  };
}

const API_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Returns true if `apiId` is a legal stable identifier. */
export function isValidApiId(apiId: string): boolean {
  return API_ID_RE.test(apiId) && apiId.length <= 64;
}
