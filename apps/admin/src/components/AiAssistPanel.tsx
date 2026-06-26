import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ContentType } from '@cw/domain';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useClient } from '../lib/client-context.js';
import { useToast } from '../lib/toast.js';

type Finding = {
  field?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction: string;
};
const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'secondary',
  info: 'outline',
} as const;

const TEXT_TYPES = new Set(['Symbol', 'Text']);
const SCALAR_TYPES = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

/**
 * AI Content OS panel for an entry: translate localized fields, summarize into a
 * field, autofill a field, or suggest taxonomy tags. Each op runs through the
 * same governed use-cases as the API; field-affecting ops re-seed the form.
 */
export function AiAssistPanel(props: {
  entryId: string;
  contentType: ContentType;
  locales: readonly string[];
  defaultLocale: string;
  onApplied: () => void;
}) {
  const { entryId, contentType, locales, defaultLocale, onApplied } = props;
  const { client } = useClient();
  const toast = useToast();
  const otherLocales = locales.filter((l) => l !== defaultLocale);
  const textFields = contentType.fields.filter((f) => TEXT_TYPES.has(f.type));
  const scalarFields = contentType.fields.filter((f) => SCALAR_TYPES.has(f.type));

  const [target, setTarget] = useState(otherLocales[0] ?? '');
  const [summaryField, setSummaryField] = useState(textFields[0]?.apiId ?? '');
  const [autofill, setAutofill] = useState(scalarFields[0]?.apiId ?? '');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const ok = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const translate = ok('translate', async () => {
    const r = await client.translateEntry(entryId, { targetLocale: target, apply: true });
    toast.success(`Translated ${r.translatedFields.length} field(s) → ${target}`);
    onApplied();
  });

  const summarize = ok('summarize', async () => {
    const r = await client.summarizeEntry(entryId, { targetField: summaryField, apply: true });
    toast.success(`Summary written to ${summaryField}`);
    void r;
    onApplied();
  });

  const fill = ok('autofill', async () => {
    await client.autofillField(entryId, { field: autofill, apply: true });
    toast.success(`Autofilled ${autofill}`);
    onApplied();
  });

  const tag = ok('tags', async () => {
    const r = await client.suggestEntryTags(entryId, { apply: true });
    toast.success(
      r.newTags.length
        ? `Tagged · new: ${r.newTags.join(', ')}`
        : `Applied ${r.tagIds.length} tag(s)`,
    );
    onApplied();
  });

  const audit = ok('audit', async () => {
    const r = await client.auditEntry(entryId);
    setFindings(r.findings);
    toast.success(`${r.findings.length} finding(s)`);
  });

  const createTasks = ok('tasks-create', async () => {
    const r = await client.auditEntry(entryId, { createTasks: true, taskSeverity: 'warning' });
    setFindings(r.findings);
    toast.success(`Created ${r.taskIds.length} work-package task(s)`);
    onApplied();
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-1.5 font-heading font-medium text-base">
          <Sparkles className="size-4 text-primary" /> AI assist
        </h2>
        <p className="text-muted-foreground text-sm">
          Translate, summarize, autofill, and classify — governed by the content model.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {otherLocales.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-muted-foreground text-xs">Translate to</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {otherLocales.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" disabled={!target || busy !== null} onClick={translate}>
              {busy === 'translate' ? '…' : 'Translate'}
            </Button>
          </div>
        )}

        {textFields.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-muted-foreground text-xs">Summarize into</Label>
              <Select value={summaryField} onValueChange={setSummaryField}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {textFields.map((f) => (
                    <SelectItem key={f.apiId} value={f.apiId}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!summaryField || busy !== null}
              onClick={summarize}
            >
              {busy === 'summarize' ? '…' : 'Summarize'}
            </Button>
          </div>
        )}

        {scalarFields.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-muted-foreground text-xs">Autofill field</Label>
              <Select value={autofill} onValueChange={setAutofill}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scalarFields.map((f) => (
                    <SelectItem key={f.apiId} value={f.apiId}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" disabled={!autofill || busy !== null} onClick={fill}>
              {busy === 'autofill' ? '…' : 'Autofill'}
            </Button>
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={busy !== null}
          onClick={tag}
        >
          {busy === 'tags' ? 'Classifying…' : 'Suggest taxonomy tags'}
        </Button>

        <div className="space-y-2 border-t pt-3">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy !== null}
              onClick={audit}
            >
              {busy === 'audit' ? 'Auditing…' : 'Audit entry'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy !== null}
              onClick={createTasks}
            >
              {busy === 'tasks-create' ? 'Creating…' : 'Audit → tasks'}
            </Button>
          </div>
          {findings && findings.length === 0 && (
            <p className="text-muted-foreground text-sm">No issues found.</p>
          )}
          {findings && findings.length > 0 && (
            <ul className="space-y-1.5">
              {findings.map((f) => (
                <li key={`${f.severity}:${f.message}`} className="text-sm">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={SEVERITY_VARIANT[f.severity]} className="text-[10px]">
                      {f.severity}
                    </Badge>
                    {f.field && (
                      <span className="font-mono text-muted-foreground text-xs">{f.field}</span>
                    )}
                  </div>
                  <p>{f.message}</p>
                  <p className="text-muted-foreground text-xs">→ {f.suggestedAction}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
