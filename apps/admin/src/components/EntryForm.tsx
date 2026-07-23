import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ContentType, EntryFields, FieldDefinition, LocaleConfig } from '@cw/domain';
import { fallbackChain, resolveLocalizedValue, validateEntryFields } from '@cw/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppExtension } from '../lib/management.js';
import { EntityPicker } from './EntityPicker.js';
import { ExtensionFrame } from './ExtensionFrame.js';
import { RichTextEditor } from './RichTextEditor.js';

const SCALAR = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

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
  /** DOM id for the form element, so external buttons can submit via `form=`. */
  formId?: string;
  /** Hides the built-in Save/Cancel row when the parent renders its own actions. */
  hideActions?: boolean;
  /** Reports edits so the parent can guard navigation against unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Called when a submit is rejected by validation, so actions living outside
   * the form (header Save/Publish) can give feedback at the point of action. */
  onValidationFailed?: (errorCount: number) => void;
  /** External field values (AI generation/canvas/assist) merged into the live
   * form state per locale — never remounts, so other unsaved edits survive. */
  mergePatch?: { seq: number; fields: EntryFields } | null;
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

  const markDirty = () => props.onDirtyChange?.(true);

  const set = (apiId: string, locale: string, v: unknown) => {
    setFieldErrors((prev) => {
      const key = errorKey(apiId, locale);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setValues((p) => ({ ...p, [apiId]: { ...p[apiId], [locale]: v } }));
    markDirty();
  };

  // Merge externally produced values (generate/canvas/AI assist) into live state.
  const appliedPatchSeq = useRef(0);
  useEffect(() => {
    const patch = props.mergePatch;
    if (!patch || patch.seq === appliedPatchSeq.current) return;
    appliedPatchSeq.current = patch.seq;
    setValues((p) => {
      const next = { ...p };
      for (const [apiId, byLocale] of Object.entries(patch.fields)) {
        next[apiId] = { ...next[apiId], ...(byLocale as Record<string, unknown>) };
      }
      return next;
    });
    setFieldErrors({});
    props.onDirtyChange?.(true);
  }, [props.mergePatch, props.onDirtyChange]);

  // Bumped per rejected submit; scrolls the error summary into view once the
  // errors have rendered (not on every fieldErrors change — typing edits those).
  const [failedSubmits, setFailedSubmits] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failedSubmits === 0) return;
    summaryRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [failedSubmits]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard double-submits (rapid ⌘S / Enter): a second createEntry in flight
    // would duplicate the entry.
    if (props.busy) return;
    const out = fieldsFromValues(contentType, values, locales, defaultLocale);
    const issues = validateEntryFields(contentType, out, {
      defaultLocale,
      locales,
    });
    if (issues.length > 0) {
      const errors = issuesToErrors(issues, defaultLocale);
      setFieldErrors(errors);
      // If the active locale is clean, jump to the first locale that isn't, so
      // the failure is never invisible (errors on unmounted tabs).
      const errorLocales = new Set(Object.keys(errors).map((k) => k.split(':')[1] ?? ''));
      if (!errorLocales.has(activeLocale)) {
        const target = locales.find((l) => errorLocales.has(l));
        if (target) setActiveLocale(target);
      }
      setFailedSubmits((n) => n + 1);
      props.onValidationFailed?.(issues.length);
      return;
    }
    setFieldErrors({});
    props.onSave(out);
  };

  // Per-locale error counts back the locale-tab badges and the summary list.
  const errorsByLocale = useMemo(() => {
    const out = new Map<string, number>();
    for (const key of Object.keys(fieldErrors)) {
      const loc = key.split(':')[1] ?? defaultLocale;
      out.set(loc, (out.get(loc) ?? 0) + 1);
    }
    return out;
  }, [fieldErrors, defaultLocale]);

  const fieldName = (apiId: string) =>
    contentType.fields.find((f) => f.apiId === apiId)?.name ?? apiId;

  return (
    <form id={props.formId} onSubmit={submit} className="max-w-2xl space-y-4">
      {hasLocalized && locales.length > 1 && (
        // Locale switcher: a segmented row of <button>s (role=button) — component
        // tests select a locale via getByRole('button', { name: 'de-DE' }).
        <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
          {locales.map((loc) => {
            const errCount = errorsByLocale.get(loc) ?? 0;
            return (
              <Button
                type="button"
                key={loc}
                size="sm"
                variant={loc === activeLocale ? 'default' : 'ghost'}
                onClick={() => setActiveLocale(loc)}
              >
                {loc}
                {loc === defaultLocale ? ' (default)' : ''}
                {errCount > 0 && (
                  <span
                    className="inline-flex h-4 min-w-4 items-center justify-center rounded-2xl bg-destructive/15 px-1 text-[10px] text-destructive"
                    aria-label={`${errCount} validation ${errCount === 1 ? 'error' : 'errors'}`}
                  >
                    {errCount}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      <Card>
        <CardContent className="space-y-5">
          {activeLocale !== defaultLocale &&
            (() => {
              const shared = contentType.fields.filter((f) => !f.localized).length;
              return shared > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {shared} {shared === 1 ? 'field' : 'fields'} shared across all locales{' '}
                  {shared === 1 ? 'is' : 'are'} edited on the {defaultLocale} (default) tab.
                </p>
              ) : null;
            })()}
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
                <Label id={`${id}-label`} htmlFor={id} className="gap-1">
                  {f.name}
                  {f.required && <span className="text-destructive">*</span>}
                  {locales.length > 1 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      {f.localized ? activeLocale : 'all locales'}
                    </span>
                  )}
                </Label>
                <FieldInput
                  id={id}
                  field={f}
                  value={values[f.apiId]?.[locale]}
                  invalid={Boolean(err)}
                  errorId={err ? `${id}-error` : undefined}
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
                {err && (
                  <p id={`${id}-error`} className="text-xs text-destructive">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {Object.keys(fieldErrors).length > 0 && (
        <div
          ref={summaryRef}
          role="alert"
          className="space-y-1 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm"
        >
          <p className="font-medium text-destructive">
            Can’t save yet: {Object.keys(fieldErrors).length}{' '}
            {Object.keys(fieldErrors).length === 1 ? 'field needs' : 'fields need'} attention.
          </p>
          <ul className="space-y-0.5">
            {Object.entries(fieldErrors).map(([key, message]) => {
              const [apiId = '', loc = defaultLocale] = key.split(':');
              return (
                <li key={key} className="text-destructive">
                  {loc === activeLocale ? (
                    <span>
                      {fieldName(apiId)} ({loc}): {message}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setActiveLocale(loc)}
                    >
                      {fieldName(apiId)} ({loc}): {message}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!props.hideActions && (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={props.busy}>
            Save draft
          </Button>
          <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

function FieldInput(props: {
  id: string;
  field: FieldDefinition;
  value: unknown;
  invalid?: boolean;
  /** id of the error message element, wired to aria-describedby when invalid. */
  errorId?: string;
  pickers: Pickers;
  editor?: AppExtension;
  editorContext?: EntryContext;
  locale: string;
  onChange: (v: unknown) => void;
}) {
  const { id, field, value, invalid, errorId, onChange, pickers, editor, editorContext, locale } =
    props;
  const inputClass = invalid ? 'border-destructive focus-visible:ring-destructive/30' : undefined;
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': errorId };

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

  // Reference fields: a searchable combobox over entries/assets, stored as
  // { id, linkType }.
  if (field.type === 'Link') {
    const linkType = field.linkType ?? 'Entry';
    const allowed = field.validations?.linkContentTypes as string[] | undefined;
    let options = linkType === 'Asset' ? pickers.assets : pickers.entries;
    if (linkType === 'Entry' && allowed?.length) {
      options = options.filter((o) => !o.contentType || allowed.includes(o.contentType));
    }
    const currentId = (value as { id?: string } | undefined)?.id ?? '';
    return (
      <EntityPicker
        id={id}
        options={options}
        value={currentId}
        placeholder={linkType === 'Asset' ? 'Search assets…' : 'Search entries…'}
        invalid={invalid}
        errorId={errorId}
        onChange={(picked) => onChange(picked ? { id: picked, linkType } : undefined)}
      />
    );
  }

  // Rich text: a Tiptap-backed document editor. Keyed per locale so each
  // locale gets its own editor instance (isolated content and undo history).
  if (field.type === 'RichText') {
    return (
      <RichTextEditor
        key={locale}
        id={id}
        ariaLabelledBy={`${id}-label`}
        value={value}
        pickers={pickers}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'Boolean') {
    return (
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(c === true)} />
        <span className="text-muted-foreground text-sm">{value ? 'Yes' : 'No'}</span>
      </div>
    );
  }
  if (field.type === 'Integer' || field.type === 'Number') {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
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
        {...aria}
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
        {...aria}
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
        {...aria}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  // Complex types (Array, JSON, Location): raw JSON editor for the MVP.
  return (
    <JsonFieldInput id={id} inputClass={inputClass} aria={aria} value={value} onChange={onChange} />
  );
}

/**
 * Raw JSON editor for complex field types. Typing through invalid syntax is
 * expected; the field says so instead of silently keeping the last valid value.
 */
function JsonFieldInput(props: {
  id: string;
  inputClass?: string;
  aria: Record<string, string | boolean | undefined>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  // Controlled text mirrored from the value, so external updates (AI merge
  // patches) show up; `lastEmitted` tells our own onChange echo apart from a
  // real external change (same pattern as RichTextEditor).
  const [text, setText] = useState(() =>
    props.value === undefined ? '' : JSON.stringify(props.value),
  );
  const lastEmitted = useRef(props.value);
  useEffect(() => {
    if (props.value === lastEmitted.current) return;
    if (JSON.stringify(props.value) === JSON.stringify(lastEmitted.current)) return;
    lastEmitted.current = props.value;
    setText(props.value === undefined ? '' : JSON.stringify(props.value));
    setInvalid(false);
  }, [props.value]);
  return (
    <div className="space-y-1">
      <Textarea
        id={props.id}
        className={props.inputClass}
        {...props.aria}
        rows={3}
        placeholder='JSON, e.g. {"lat": 52.52, "lon": 13.4}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') {
            setInvalid(false);
            lastEmitted.current = undefined;
            props.onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(e.target.value);
            lastEmitted.current = parsed;
            props.onChange(parsed);
            setInvalid(false);
          } catch {
            // Keep the last valid value until the text parses again.
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <p className="text-warning text-xs">
          Not valid JSON yet. Until the syntax is fixed, the last valid value is what saves.
        </p>
      )}
    </div>
  );
}
