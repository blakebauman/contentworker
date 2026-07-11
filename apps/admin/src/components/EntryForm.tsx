import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ContentType, EntryFields, FieldDefinition, LocaleConfig } from '@cw/domain';
import { fallbackChain, resolveLocalizedValue, validateEntryFields } from '@cw/domain';
import { useMemo, useState } from 'react';
import type { AppExtension } from '../lib/management.js';
import { ExtensionFrame } from './ExtensionFrame.js';
import { RichTextEditor } from './RichTextEditor.js';

const SCALAR = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);
// Radix Select forbids an empty-string item value; use a sentinel for "no link".
const NONE = '__none__';

/** A selectable reference target (entry or asset). */
export interface PickOption {
  readonly id: string;
  readonly label: string;
  readonly contentType?: string;
}

export interface Pickers {
  readonly entries: PickOption[];
  readonly assets: PickOption[];
}

/** Per-field, per-locale working state: `{ apiId: { locale: value } }`. */
type Values = Record<string, Record<string, unknown>>;

/** Per-field, per-locale validation messages from the domain validator. */
type FieldErrors = Record<string, string>;

function errorKey(apiId: string, locale: string): string {
  return `${apiId}:${locale}`;
}

function fieldsFromValues(
  contentType: ContentType,
  values: Values,
  locales: readonly string[],
  defaultLocale: string,
): EntryFields {
  const out: EntryFields = {};
  for (const f of contentType.fields) {
    const byLocale = values[f.apiId] ?? {};
    const fieldLocales = f.localized ? locales : [defaultLocale];
    const cleaned: Record<string, unknown> = {};
    for (const loc of fieldLocales) {
      const v = byLocale[loc];
      if (v !== undefined && v !== '') cleaned[loc] = v;
    }
    if (Object.keys(cleaned).length > 0) out[f.apiId] = cleaned;
  }
  return out;
}

function issuesToErrors(
  issues: ReturnType<typeof validateEntryFields>,
  defaultLocale: string,
): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const locale = issue.locale ?? defaultLocale;
    out[errorKey(issue.field, locale)] = issue.message;
  }
  return out;
}

function formatFallbackPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '…';
}

function fallbackHint(
  field: FieldDefinition,
  values: Values,
  locale: string,
  localeConfig: LocaleConfig,
): string | undefined {
  if (!field.localized || locale === localeConfig.defaultLocale) return undefined;
  const byLocale = values[field.apiId] ?? {};
  const current = byLocale[locale];
  if (current !== undefined && current !== '') return undefined;

  const resolved = resolveLocalizedValue(byLocale, localeConfig, locale);
  if (resolved === undefined) return undefined;

  for (const loc of fallbackChain(localeConfig, locale)) {
    if (loc === locale) continue;
    const v = byLocale[loc];
    if (v !== undefined && v !== null && v !== '') {
      return `Falls back to ${loc}: ${formatFallbackPreview(v)}`;
    }
  }
  return undefined;
}

const cloneInitial = (initial: EntryFields): Values => {
  const out: Values = {};
  for (const [apiId, byLocale] of Object.entries(initial)) {
    out[apiId] = { ...(byLocale as Record<string, unknown>) };
  }
  return out;
};

/**
 * A form generated from a content type's field definitions. Localized fields are
 * edited per-locale via tabs; non-localized fields are edited once (on the default
 * locale tab). Emits the localized `EntryFields` shape, dropping empty values.
 */
/** The entry being edited, posted to field-editor extensions for context. */
export interface EntryContext {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId?: string;
  readonly contentType?: string;
}

export function EntryForm(props: {
  contentType: ContentType;
  initial: EntryFields;
  locales: readonly string[];
  defaultLocale: string;
  fallbacks?: Readonly<Record<string, string | null>>;
  pickers: Pickers;
  /** Installed custom field editors; the first matching a field's type replaces its input. */
  fieldEditors?: readonly AppExtension[];
  entryContext?: EntryContext;
  busy?: boolean;
  onSave: (fields: EntryFields) => void;
  onCancel: () => void;
}) {
  const { contentType, locales, defaultLocale, fallbacks, fieldEditors } = props;
  const [values, setValues] = useState<Values>(() => cloneInitial(props.initial));
  const [activeLocale, setActiveLocale] = useState(defaultLocale);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const hasLocalized = useMemo(() => contentType.fields.some((f) => f.localized), [contentType]);

  const localeConfig = useMemo<LocaleConfig>(
    () => ({ defaultLocale, locales, fallbacks }),
    [defaultLocale, locales, fallbacks],
  );

  const set = (apiId: string, locale: string, v: unknown) => {
    setFieldErrors((prev) => {
      const key = errorKey(apiId, locale);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setValues((p) => ({ ...p, [apiId]: { ...p[apiId], [locale]: v } }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const out = fieldsFromValues(contentType, values, locales, defaultLocale);
    const issues = validateEntryFields(contentType, out, {
      defaultLocale,
      locales,
    });
    if (issues.length > 0) {
      setFieldErrors(issuesToErrors(issues, defaultLocale));
      return;
    }
    setFieldErrors({});
    props.onSave(out);
  };

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      {hasLocalized && locales.length > 1 && (
        // Locale switcher: a segmented row of <button>s (role=button) — component
        // tests select a locale via getByRole('button', { name: 'de-DE' }).
        <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {locales.map((loc) => (
            <Button
              type="button"
              key={loc}
              size="sm"
              variant={loc === activeLocale ? 'default' : 'ghost'}
              onClick={() => setActiveLocale(loc)}
            >
              {loc}
              {loc === defaultLocale ? ' (default)' : ''}
            </Button>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="space-y-5">
          {contentType.fields.map((f) => {
            // Non-localized fields are only editable on the default-locale tab.
            const locale = f.localized ? activeLocale : defaultLocale;
            if (!f.localized && activeLocale !== defaultLocale) return null;
            const id = `field-${f.apiId}`;
            const err = fieldErrors[errorKey(f.apiId, locale)];
            const hint =
              f.localized && locales.length > 1
                ? fallbackHint(f, values, locale, localeConfig)
                : undefined;
            return (
              <div className="space-y-1.5" key={f.apiId}>
                <Label htmlFor={id} className="gap-1">
                  {f.name}
                  {f.required && <span className="text-destructive">*</span>}
                  <span className="ml-1 font-normal text-muted-foreground">
                    {f.type}
                    {f.localized ? ` · ${activeLocale}` : ' · not localized'}
                  </span>
                </Label>
                <FieldInput
                  id={id}
                  field={f}
                  value={values[f.apiId]?.[locale]}
                  invalid={Boolean(err)}
                  pickers={props.pickers}
                  editor={fieldEditors?.find(
                    (e) =>
                      !e.fieldTypes || e.fieldTypes.length === 0 || e.fieldTypes.includes(f.type),
                  )}
                  editorContext={props.entryContext}
                  locale={locale}
                  onChange={(v) => set(f.apiId, locale, v)}
                />
                {hint && !err && <p className="text-xs text-muted-foreground">{hint}</p>}
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={props.busy}>
          Save draft
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FieldInput(props: {
  id: string;
  field: FieldDefinition;
  value: unknown;
  invalid?: boolean;
  pickers: Pickers;
  editor?: AppExtension;
  editorContext?: EntryContext;
  locale: string;
  onChange: (v: unknown) => void;
}) {
  const { id, field, value, invalid, onChange, pickers, editor, editorContext, locale } = props;
  const inputClass = invalid ? 'border-destructive focus-visible:ring-destructive/30' : undefined;

  // A custom field editor extension takes over the input entirely (sandboxed iframe).
  if (editor) {
    return (
      <ExtensionFrame
        extension={editor}
        context={{
          target: 'field-editor',
          spaceId: editorContext?.spaceId ?? '',
          environmentId: editorContext?.environmentId ?? '',
          entryId: editorContext?.entryId,
          contentType: editorContext?.contentType,
          field: { apiId: field.apiId, type: field.type, locale },
          value,
        }}
        onChange={onChange}
      />
    );
  }

  // Reference fields: a dropdown of entries/assets, stored as { id, linkType }.
  if (field.type === 'Link') {
    const linkType = field.linkType ?? 'Entry';
    const allowed = field.validations?.linkContentTypes as string[] | undefined;
    let options = linkType === 'Asset' ? pickers.assets : pickers.entries;
    if (linkType === 'Entry' && allowed?.length) {
      options = options.filter((o) => !o.contentType || allowed.includes(o.contentType));
    }
    const currentId = (value as { id?: string } | undefined)?.id ?? '';
    return (
      <Select
        value={currentId || NONE}
        onValueChange={(v) => onChange(v === NONE ? undefined : { id: v, linkType })}
      >
        <SelectTrigger id={id} className={inputClass}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— none —</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Rich text: a structured block editor (paragraphs/headings/quotes + embeds).
  if (field.type === 'RichText') {
    return <RichTextEditor id={id} value={value} pickers={pickers} onChange={onChange} />;
  }

  if (field.type === 'Boolean') {
    return (
      <div>
        <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(c === true)} />
      </div>
    );
  }
  if (field.type === 'Integer' || field.type === 'Number') {
    return (
      <Input
        id={id}
        className={inputClass}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  if (field.type === 'Date') {
    return (
      <Input
        id={id}
        className={inputClass}
        type="date"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'Text') {
    return (
      <Textarea
        id={id}
        className={inputClass}
        rows={4}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (SCALAR.has(field.type)) {
    return (
      <Input
        id={id}
        className={inputClass}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  // Complex types (Array, JSON, Location): raw JSON editor for the MVP.
  return (
    <Textarea
      id={id}
      className={inputClass}
      rows={3}
      placeholder="JSON value"
      defaultValue={value === undefined ? '' : JSON.stringify(value)}
      onChange={(e) => {
        try {
          onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value));
        } catch {
          /* keep last valid value until parseable */
        }
      }}
    />
  );
}
