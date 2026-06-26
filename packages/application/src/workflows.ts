import {
  type EntryWorkflowState,
  NotFoundError,
  type Scope,
  type WorkflowDefinition,
  type WorkflowStep,
  assertCanEnterStep,
  assertValidWorkflow,
} from '@cw/domain';
import type { AppContext } from './context.js';

export interface DefineWorkflowInput {
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
}

/** Creates or replaces a workflow definition (ordered, scope-gated steps). */
export async function defineWorkflow(
  ctx: AppContext,
  scope: Scope,
  input: DefineWorkflowInput,
): Promise<WorkflowDefinition> {
  assertValidWorkflow(input.steps);
  const def: WorkflowDefinition = {
    id: ctx.ids.newId(),
    name: input.name,
    steps: input.steps,
  };
  await ctx.store.workflows.saveDefinition(scope, def);
  return def;
}

export async function listWorkflows(ctx: AppContext, scope: Scope): Promise<WorkflowDefinition[]> {
  return ctx.store.workflows.listDefinitions(scope);
}

export async function getWorkflow(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<WorkflowDefinition> {
  const def = await ctx.store.workflows.getDefinition(scope, id);
  if (!def) throw new NotFoundError('Workflow', id);
  return def;
}

export async function deleteWorkflow(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await getWorkflow(ctx, scope, id);
  await ctx.store.workflows.deleteDefinition(scope, id);
}

export async function getEntryWorkflowState(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryWorkflowState | null> {
  return ctx.store.workflows.getState(scope, entryId);
}

export interface TransitionInput {
  readonly entryId: string;
  readonly workflowId: string;
  readonly toStepId: string;
}

/**
 * Moves an entry into a workflow step. The caller must hold the target step's
 * `requiredScope` — enforced here (not by a static route guard) because the
 * required scope is data-driven by the workflow definition. `callerScopes` is
 * the requesting principal's granted scopes, so the SAME rule applies whether
 * the move comes from the HTTP API or an MCP tool.
 */
export async function transitionEntry(
  ctx: AppContext,
  scope: Scope,
  input: TransitionInput,
  callerScopes: readonly string[],
): Promise<EntryWorkflowState> {
  if (!(await ctx.store.entries.get(scope, input.entryId))) {
    throw new NotFoundError('Entry', input.entryId);
  }
  const def = await ctx.store.workflows.getDefinition(scope, input.workflowId);
  if (!def) throw new NotFoundError('Workflow', input.workflowId);

  // Resolves the step AND enforces its required scope (throws ForbiddenError).
  assertCanEnterStep(def, input.toStepId, callerScopes);

  const state: EntryWorkflowState = {
    entryId: input.entryId,
    workflowId: input.workflowId,
    currentStepId: input.toStepId,
  };
  await ctx.store.workflows.saveState(scope, state);
  return state;
}
