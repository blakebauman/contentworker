import {
  addComment,
  createTask,
  defineWorkflow,
  listWorkflows,
  resolveTask,
  transitionEntry,
} from '@cw/application';
import { scopesForKind } from '@cw/domain';
import { pick } from './helpers.js';
import type { SeedRun } from './types.js';

/**
 * Editorial collaboration: one scope-gated workflow with entries spread across
 * its steps, threaded comments, and a mix of open/assigned/resolved tasks.
 * Guarded by the workflow's existence (one list query when already seeded).
 */
export async function seedCollaboration(
  run: SeedRun,
  articleIds: readonly string[],
): Promise<void> {
  const { ctx, scope } = run;
  if (articleIds.length < 6) return;

  const workflows = await listWorkflows(ctx, scope);
  if (workflows.some((w) => w.name === 'Editorial review')) return;

  const workflow = await defineWorkflow(ctx, scope, {
    name: 'Editorial review',
    steps: [
      { id: 'draft', name: 'Draft', requiredScope: 'content:write' },
      { id: 'review', name: 'In review', requiredScope: 'content:write' },
      { id: 'approved', name: 'Approved', requiredScope: 'content:publish' },
    ],
  });
  // Seeding acts as a management principal; transition enforcement stays live.
  const callerScopes = scopesForKind('cma');
  const steps = ['draft', 'review', 'approved'] as const;
  for (let i = 0; i < 6; i++) {
    await transitionEntry(
      ctx,
      scope,
      { entryId: articleIds[i]!, workflowId: workflow.id, toStepId: pick(steps, i) },
      callerScopes,
    );
  }

  const authors = ['jordan@example.com', 'alex@example.com', 'sam@example.com'] as const;
  for (let i = 0; i < 5; i++) {
    const entryId = articleIds[i]!;
    const root = await addComment(ctx, scope, {
      entryId,
      author: pick(authors, i),
      body: `Can we tighten the intro on this one? (seeded comment ${i + 1})`,
    });
    if (i < 2) {
      await addComment(ctx, scope, {
        entryId,
        author: pick(authors, i + 1),
        parentId: root.id,
        body: 'Agreed — drafting a shorter opening now.',
      });
      await addComment(ctx, scope, {
        entryId,
        author: pick(authors, i + 2),
        parentId: root.id,
        body: 'Ship it once the summary matches.',
      });
    }
  }

  const taskBodies = [
    'Fact-check the benchmark numbers',
    'Add alt text to the hero image',
    'Confirm the release date with marketing',
    'Translate summary to German',
    'Link the related product entries',
    'Review SEO description length',
  ] as const;
  for (let i = 0; i < taskBodies.length; i++) {
    const task = await createTask(ctx, scope, {
      entryId: pick([...articleIds.slice(0, 6)], i),
      body: taskBodies[i]!,
      assignee: i % 3 === 0 ? pick(authors, i) : undefined,
    });
    if (i >= taskBodies.length - 2) await resolveTask(ctx, scope, task.id);
  }
}
