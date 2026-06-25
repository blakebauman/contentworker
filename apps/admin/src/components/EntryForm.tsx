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
import type { ContentType, EntryFields, FieldDefinition } from '@cw/domain';
import { useMemo, useState } from 'react';

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
export function EntryForm(props: {
  contentType: ContentType;
  initial: EntryFields;
  locales: readonly string[];
  defaultLocale: string;
  pickers: Pickers;
  busy?: boolean;
  onSave: (fields: EntryFields) => void;
  onCancel: () => void;
}) {
  const { contentType, locales, defaultLocale } = props;
  const [values, setValues] = useState<Values>(() => cloneInitial(props.initial));
  const [activeLocale, setActiveLocale] = useState(defaultLocale);
  const hasLocalized = useMemo(() => contentType.fields.some((f) => f.localized), [contentType]);

  const set = (apiId: string, locale: string, v: unknown) =>
    setValues((p) => ({ ...p, [apiId]: { ...p[apiId], [locale]: v } }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
                  pickers={props.pickers}
                  onChange={(v) => set(f.apiId, locale, v)}
                />
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

// --- rich text: a minimal paragraph document ---------------------------------

interface RichTextNode {
  nodeType: string;
  value?: string;
  content?: RichTextNode[];
}

/** Flattens a rich-text document to plain text (one paragraph per line). */
function richToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const content = (doc as RichTextNode).content ?? [];
  return content.map((p) => (p.content ?? []).map((t) => t.value ?? '').join('')).join('\n');
}

/** Builds a rich-text document (a paragraph per line) from plain text. */
function textToRich(text: string): RichTextNode {
  return {
    nodeType: 'document',
    content: text.split('\n').map((line) => ({
      nodeType: 'paragraph',
      content: [{ nodeType: 'text', value: line }],
    })),
  };
}

function FieldInput(props: {
  id: string;
  field: FieldDefinition;
  value: unknown;
  pickers: Pickers;
  onChange: (v: unknown) => void;
}) {
  const { id, field, value, onChange, pickers } = props;

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
        <SelectTrigger id={id}>
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

  // Rich text: a plain-text editor backed by a simple paragraph document.
  if (field.type === 'RichText') {
    return (
      <Textarea
        id={id}
        rows={6}
        placeholder="Rich text…"
        value={richToText(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : textToRich(e.target.value))}
      />
    );
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
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  // Complex types (Array, JSON, Location): raw JSON editor for the MVP.
  return (
    <Textarea
      id={id}
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
