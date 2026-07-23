import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { PermissionScope, WorkflowStep } from '@cw/domain';
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import { useInvalidate, useScopedQuery } from '../lib/queries.js';
import { useToast } from '../lib/toast.js';

/** Scopes that make sense as the gate to move an entry into a step. */
const STEP_SCOPES: { value: PermissionScope; label: string }[] = [
  { value: 'preview:read', label: 'Anyone (preview:read)' },
  { value: 'content:write', label: 'Editors (content:write)' },
  { value: 'content:publish', label: 'Publishers (content:publish)' },
  { value: 'content:manage', label: 'Managers (content:manage)' },
];

interface StepDraft {
  name: string;
  requiredScope: PermissionScope;
}

/** Derives a stable, unique-within-workflow step id from its name. */
function stepId(name: string, index: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug ? `${slug}-${index}` : `step-${index}`;
}

/** Workflow definitions admin: ordered, scope-gated editorial steps (P13). */
export function Workflows() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);

  const workflowsQuery = useScopedQuery(['workflows'], () => client.listWorkflows());
  const workflows = workflowsQuery.data ?? [];
  const loading = workflowsQuery.isPending;

  const remove = (id: string) =>
    run(async () => {
      await client.deleteWorkflow(id);
      toast.success('Workflow deleted');
      await invalidate(['workflows']);
    });

  const create = (name: string, steps: WorkflowStep[]) =>
    run(async () => {
      await client.defineWorkflow({ name, steps });
      setCreating(false);
      toast.success('Workflow created');
      await invalidate(['workflows']);
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Workflows"
        description="Define ordered editorial steps; each step is gated by a permission scope."
      >
        <Button type="button" onClick={() => setCreating(true)} disabled={busy}>
          + New workflow
        </Button>
      </PageHeader>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No workflows yet"
          description="Create a workflow to move entries through review steps like Draft → In review → Approved."
        >
          <Button type="button" onClick={() => setCreating(true)}>
            Create workflow
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {workflows.map((w) => (
            <Card key={w.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle>{w.name}</CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Delete workflow"
                    onClick={() => remove(w.id)}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-wrap items-center gap-1.5">
                  {w.steps.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-muted-foreground">→</span>}
                      <Badge variant="outline" title={s.requiredScope}>
                        {s.name}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateWorkflowDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={create}
        busy={busy}
      />
    </div>
  );
}

function CreateWorkflowDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, steps: WorkflowStep[]) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([
    { name: 'Draft', requiredScope: 'preview:read' },
    { name: 'In review', requiredScope: 'content:write' },
    { name: 'Approved', requiredScope: 'content:publish' },
  ]);

  useEffect(() => {
    if (props.open) {
      setName('');
      setSteps([
        { name: 'Draft', requiredScope: 'preview:read' },
        { name: 'In review', requiredScope: 'content:write' },
        { name: 'Approved', requiredScope: 'content:publish' },
      ]);
    }
  }, [props.open]);

  const patch = (i: number, p: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const addStep = () => setSteps((prev) => [...prev, { name: '', requiredScope: 'content:write' }]);
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, j) => j !== i));

  const valid = name.trim() && steps.length > 0 && steps.every((s) => s.name.trim());

  const submit = () => {
    const built: WorkflowStep[] = steps.map((s, i) => ({
      id: stepId(s.name, i),
      name: s.name.trim(),
      requiredScope: s.requiredScope,
    }));
    props.onCreate(name.trim(), built);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Steps run in order. An entry enters at the first step; moving into any step requires its
            scope.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">Name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Editorial review"
            />
          </div>
          <div className="space-y-2">
            <Label>Steps</Label>
            {steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional step rows
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={s.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                  placeholder={`Step ${i + 1}`}
                  className="flex-1"
                />
                <Select
                  value={s.requiredScope}
                  onValueChange={(v) => patch(i, { requiredScope: v as PermissionScope })}
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STEP_SCOPES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Remove step"
                  disabled={steps.length === 1}
                  onClick={() => removeStep(i)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addStep}>
              <Plus className="size-4" />
              Add step
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!valid || props.busy} onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
