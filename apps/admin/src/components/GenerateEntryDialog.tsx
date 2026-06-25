import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ModelTier } from '../lib/management.js';

const TIERS: { value: ModelTier; label: string }[] = [
  { value: 'fast', label: 'Fast (Haiku)' },
  { value: 'balanced', label: 'Balanced (Sonnet)' },
  { value: 'flagship', label: 'Flagship (Opus)' },
];

/**
 * Prompts the model to draft this content type's fields. The generated values
 * fill the editor form; they still pass the same validators a human write does.
 */
export function GenerateEntryDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentTypeName: string;
  onGenerate: (prompt: string, tier: ModelTier) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onGenerate(prompt.trim(), tier);
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Generate {props.contentTypeName} with AI
          </DialogTitle>
          <DialogDescription>
            Describe what to write. The model drafts the fields; you can edit before saving.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gen-prompt">Prompt</Label>
            <Textarea
              id="gen-prompt"
              rows={5}
              placeholder="e.g. A launch announcement for our new realtime sync feature, upbeat and concise."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gen-tier">Model</Label>
            <Select value={tier} onValueChange={(v) => setTier(v as ModelTier)}>
              <SelectTrigger id="gen-tier" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !prompt.trim()}>
              {busy ? 'Generating…' : 'Generate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
