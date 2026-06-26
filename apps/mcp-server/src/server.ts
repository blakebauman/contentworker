import {
  addComment,
  addEntryToRelease,
  autoTagAsset,
  autofillField,
  compareEnvironments,
  createAIAction,
  createConcept,
  createContentType,
  createEntry,
  createRelease,
  createScheme,
  createTag,
  createTask,
  deleteEnvironmentAlias,
  diffVersions,
  draftEntry,
  generateAltText,
  getAssetUsage,
  getContentType,
  getPreviewEntry,
  getRelease,
  listAIActions,
  listAssets,
  listAuditLog,
  listComments,
  listConcepts,
  listContentTypes,
  listEnvironmentAliases,
  listPreviewEntries,
  listReleases,
  listTags,
  listTasks,
  listVersions,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  publishRelease,
  resolveTask,
  restoreVersion,
  runAIAction,
  scheduleAction,
  semanticSearch,
  setAssetMetadata,
  setEntryMetadata,
  setEnvironmentAlias,
  suggestEntryTags,
  summarizeEntry,
  transformAssetUrl,
  transitionEntry,
  translateEntry,
  unpublishEntry,
  updateEntry,
} from '@cw/application';
import {
  type EntryFields,
  FIELD_TYPES,
  type PermissionScope,
  type Principal,
  SCOPES,
  type Scope,
  authorize,
} from '@cw/domain';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpDeps } from './wire.js';

const DEFAULT_SPACE = process.env.SEED_SPACE_ID ?? 'space-1';
const DEFAULT_ENV = process.env.SEED_ENV_ID ?? 'main';

const scopeArgs = {
  space: z.string().optional().describe('Space id (defaults to the server default).'),
  environment: z.string().optional().describe('Environment id (defaults to "main").'),
};
const scopeOf = (a: { space?: string; environment?: string }): Scope => ({
  spaceId: a.space ?? DEFAULT_SPACE,
  environmentId: a.environment ?? DEFAULT_ENV,
});

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const fieldSchema = z.object({
  apiId: z.string(),
  name: z.string(),
  type: z.enum(FIELD_TYPES as unknown as [string, ...string[]]),
  localized: z.boolean().default(false),
  required: z.boolean().default(false),
  position: z.number().int(),
  validations: z.record(z.any()).optional(),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  items: z.record(z.any()).optional(),
});
const entryFields = z.record(z.record(z.any())).describe('fieldApiId -> { locale: value }');

/**
 * Builds the MCP server for a resolved principal. Each tool authorizes the
 * caller's scopes against the target space before delegating to a core
 * use-case — so MCP enforces the SAME RBAC as the HTTP API.
 */
export function buildServer(deps: McpDeps, principal: Principal): McpServer {
  const { ctx, ai, rag } = deps;
  const server = new McpServer({ name: 'contentworker', version: '0.1.0' });
  const guard = (scope: PermissionScope, s: Scope) => authorize(principal, scope, s.spaceId);

  // --- read / query / search ---------------------------------------------
  server.tool(
    'model_list_content_types',
    'List the content types defined in a space/environment.',
    scopeArgs,
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listContentTypes(ctx, scopeOf(args)));
    },
  );

  server.tool(
    'model_get_content_type',
    'Get a single content type definition by its apiId.',
    { apiId: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.tool(
    'entries_query',
    'List entries (current/draft versions) with optional field-level filters, ' +
      'ordering, projection, and full-text search.',
    {
      contentType: z.string().optional(),
      limit: z.number().int().positive().optional(),
      skip: z.number().int().nonnegative().optional(),
      locale: z.string().optional(),
      filters: z
        .array(
          z.object({
            field: z.string().describe('field apiId or a sys.* pseudo-field'),
            op: z.enum(['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'match']),
            value: z.any().optional(),
          }),
        )
        .optional(),
      order: z
        .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
        .optional(),
      select: z.array(z.string()).optional().describe('field apiIds to return'),
      search: z.string().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await listPreviewEntries(ctx, scopeOf(args), {
          contentTypeApiId: args.contentType,
          limit: args.limit,
          skip: args.skip,
          locale: args.locale,
          filters: args.filters,
          order: args.order,
          select: args.select,
          search: args.search,
        }),
      );
    },
  );

  server.tool(
    'entries_get',
    'Get a single entry (current/draft version) by id.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getPreviewEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'content_semantic_search',
    'Semantic search over published content using vector embeddings.',
    { query: z.string(), topK: z.number().int().positive().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.searchRead, scopeOf(args));
      return ok(await semanticSearch(rag, scopeOf(args), args.query, { topK: args.topK }));
    },
  );

  server.tool(
    'generate_draft',
    'Generate draft field values for a content type from a prompt. Validated against ' +
      'the content model before being returned. Pair with entries_create to author it.',
    {
      contentType: z.string(),
      prompt: z.string(),
      tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await draftEntry(ctx, ai, scopeOf(args), {
          contentTypeApiId: args.contentType,
          prompt: args.prompt,
          tier: args.tier,
        }),
      );
    },
  );

  // --- AI content operations over an entry -------------------------------
  server.tool(
    'entry_translate',
    'Translate an entry’s localized text fields into a target locale; ' +
      'apply=true saves a new draft version.',
    {
      id: z.string(),
      targetLocale: z.string(),
      sourceLocale: z.string().optional(),
      apply: z.boolean().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await translateEntry(ctx, ai, scopeOf(args), args.id, {
          targetLocale: args.targetLocale,
          sourceLocale: args.sourceLocale,
          apply: args.apply,
        }),
      );
    },
  );

  server.tool(
    'entry_summarize',
    'Summarize an entry’s text content; apply=true writes it to targetField.',
    {
      id: z.string(),
      locale: z.string().optional(),
      maxWords: z.number().int().positive().optional(),
      targetField: z.string().optional(),
      apply: z.boolean().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await summarizeEntry(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          maxWords: args.maxWords,
          targetField: args.targetField,
          apply: args.apply,
        }),
      );
    },
  );

  server.tool(
    'entry_autofill_field',
    'Generate a value for one scalar field from the entry’s other fields; ' +
      'apply=true saves it. Validated against the content model.',
    {
      id: z.string(),
      field: z.string(),
      locale: z.string().optional(),
      instructions: z.string().optional(),
      apply: z.boolean().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await autofillField(ctx, ai, scopeOf(args), args.id, {
          field: args.field,
          locale: args.locale,
          instructions: args.instructions,
          apply: args.apply,
        }),
      );
    },
  );

  server.tool(
    'entry_suggest_tags',
    'Suggest taxonomy tags for an entry (matching the vocabulary, proposing ' +
      'new names); apply=true creates + assigns them.',
    { id: z.string(), apply: z.boolean().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await suggestEntryTags(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  // --- AI Actions (templated, governed operations) -----------------------
  server.tool(
    'ai_actions_list',
    'List the reusable AI Actions defined in a space/environment.',
    scopeArgs,
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAIActions(ctx, scopeOf(args)));
    },
  );

  server.tool(
    'ai_action_create',
    'Create a reusable AI Action: a prompt template with {{variables}} and an ' +
      'optional targetField the run writes into. Variables are derived from the template.',
    {
      name: z.string(),
      promptTemplate: z.string(),
      description: z.string().optional(),
      targetField: z.string().optional(),
      tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAIAction(ctx, scopeOf(args), {
          name: args.name,
          promptTemplate: args.promptTemplate,
          description: args.description,
          targetField: args.targetField,
          tier: args.tier,
        }),
      );
    },
  );

  server.tool(
    'ai_action_run',
    'Run a stored AI Action. Pass variables, and/or an entryId whose fields ' +
      'become {{field.<apiId>}}; apply=true writes the output into the targetField.',
    {
      id: z.string(),
      entryId: z.string().optional(),
      variables: z.record(z.string()).optional(),
      locale: z.string().optional(),
      apply: z.boolean().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await runAIAction(ctx, ai, scopeOf(args), args.id, {
          entryId: args.entryId,
          variables: args.variables,
          locale: args.locale,
          apply: args.apply,
        }),
      );
    },
  );

  // --- write -------------------------------------------------------------
  server.tool(
    'model_create_content_type',
    'Create or update a content type definition.',
    {
      apiId: z.string(),
      name: z.string(),
      displayField: z.string(),
      fields: z.array(fieldSchema),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createContentType(ctx, scopeOf(args), {
          apiId: args.apiId,
          name: args.name,
          displayField: args.displayField,
          // biome-ignore lint/suspicious/noExplicitAny: zod field shape → domain FieldDefinition
          fields: args.fields as any,
        }),
      );
    },
  );

  server.tool(
    'model_publish_content_type',
    'Publish a content type so entries can be delivered against it.',
    { apiId: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.tool(
    'entries_create',
    'Create a draft entry. Fields are validated against the content model.',
    { contentType: z.string(), fields: entryFields, ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createEntry(ctx, scopeOf(args), {
          contentTypeApiId: args.contentType,
          fields: args.fields as EntryFields,
        }),
      );
    },
  );

  server.tool(
    'entries_update',
    'Save new field values as a new draft version of an entry.',
    { id: z.string(), fields: entryFields, ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await updateEntry(ctx, scopeOf(args), args.id, args.fields as EntryFields));
    },
  );

  server.tool(
    'entries_publish',
    'Publish an entry (validates references; emits an entry.published event).',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'entries_unpublish',
    'Withdraw an entry from the Delivery API.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await unpublishEntry(ctx, scopeOf(args), args.id));
    },
  );

  // --- entry version history ---------------------------------------------
  server.tool(
    'entries_list_versions',
    'List every saved version of an entry, newest first.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listVersions(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'entries_diff_versions',
    'Diff two versions of an entry field-by-field (from → to).',
    { id: z.string(), from: z.number(), to: z.number(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await diffVersions(ctx, scopeOf(args), args.id, args.from, args.to));
    },
  );

  server.tool(
    'entries_restore_version',
    'Restore an older version by copying its fields into a new draft version.',
    { id: z.string(), version: z.number(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await restoreVersion(ctx, scopeOf(args), args.id, args.version));
    },
  );

  // --- releases & scheduling ---------------------------------------------
  server.tool(
    'releases_list',
    'List releases (entry bundles published together) in a space/environment.',
    scopeArgs,
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listReleases(ctx, scopeOf(args)));
    },
  );

  server.tool(
    'releases_get',
    'Get a release with its member entries.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getRelease(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'releases_create',
    'Create an open release to group entries for atomic publishing.',
    { title: z.string(), description: z.string().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createRelease(ctx, scopeOf(args), {
          title: args.title,
          description: args.description,
        }),
      );
    },
  );

  server.tool(
    'releases_add_entry',
    'Add an entry to an open release, choosing whether it publishes or unpublishes.',
    {
      releaseId: z.string(),
      entryId: z.string(),
      action: z.enum(['publish', 'unpublish']).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addEntryToRelease(ctx, scopeOf(args), args.releaseId, {
          entityId: args.entryId,
          action: args.action,
        }),
      );
    },
  );

  server.tool(
    'releases_publish',
    'Ship a release: publish/unpublish every member atomically in one transaction.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishRelease(ctx, scopeOf(args), args.id));
    },
  );

  // --- collaboration: comments, tasks, workflow --------------------------
  server.tool(
    'comments_list',
    'List comments on an entry (oldest first; threaded via parentId).',
    { entryId: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listComments(ctx, scopeOf(args), args.entryId));
    },
  );

  server.tool(
    'comments_add',
    'Add a comment (or threaded reply) to an entry.',
    {
      entryId: z.string(),
      body: z.string(),
      author: z.string().optional(),
      parentId: z.string().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addComment(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          author: args.author ?? principal.kind,
          parentId: args.parentId,
        }),
      );
    },
  );

  server.tool(
    'tasks_list',
    'List tasks on an entry.',
    { entryId: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTasks(ctx, scopeOf(args), args.entryId));
    },
  );

  server.tool(
    'tasks_create',
    'Create an editorial task on an entry, optionally assigned to someone.',
    { entryId: z.string(), body: z.string(), assignee: z.string().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createTask(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          assignee: args.assignee,
        }),
      );
    },
  );

  server.tool(
    'tasks_resolve',
    'Mark a task resolved.',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await resolveTask(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'workflow_transition',
    'Move an entry into a workflow step. The target step may require a scope the ' +
      'caller must hold (enforced from the workflow definition).',
    { entryId: z.string(), workflowId: z.string(), toStepId: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await transitionEntry(
          ctx,
          scopeOf(args),
          { entryId: args.entryId, workflowId: args.workflowId, toStepId: args.toStepId },
          principal.scopes,
        ),
      );
    },
  );

  // --- taxonomy ----------------------------------------------------------
  server.tool(
    'taxonomy_list_tags',
    'List the flat tags defined in a space/environment.',
    scopeArgs,
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTags(ctx, scopeOf(args)));
    },
  );

  server.tool(
    'taxonomy_create_tag',
    'Create a flat tag.',
    { name: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createTag(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.tool(
    'taxonomy_create_scheme',
    'Create a concept scheme (a controlled vocabulary).',
    { name: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createScheme(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.tool(
    'taxonomy_list_concepts',
    'List concepts, optionally limited to one scheme.',
    { scheme: z.string().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listConcepts(ctx, scopeOf(args), args.scheme));
    },
  );

  server.tool(
    'taxonomy_create_concept',
    'Create a concept within a scheme, optionally nested under a broader concept.',
    {
      schemeId: z.string(),
      prefLabel: z.string(),
      broaderId: z.string().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createConcept(ctx, scopeOf(args), {
          schemeId: args.schemeId,
          prefLabel: args.prefLabel,
          broaderId: args.broaderId,
        }),
      );
    },
  );

  server.tool(
    'entries_set_metadata',
    "Set an entry's taxonomy associations (tag ids + concept ids). Takes effect " +
      'on the next publish.',
    {
      entryId: z.string(),
      tags: z.array(z.string()).optional(),
      concepts: z.array(z.string()).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setEntryMetadata(ctx, scopeOf(args), args.entryId, {
          tags: args.tags,
          concepts: args.concepts,
        }),
      );
    },
  );

  server.tool(
    'schedule_action',
    'Schedule a publish/unpublish of an entry or release for a future ISO-8601 instant.',
    {
      action: z.enum(['publish', 'unpublish']),
      entityType: z.enum(['Entry', 'Release']),
      entityId: z.string(),
      scheduledFor: z.string().describe('ISO-8601 instant'),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await scheduleAction(ctx, scopeOf(args), {
          action: args.action,
          entityType: args.entityType,
          entityId: args.entityId,
          scheduledFor: args.scheduledFor,
        }),
      );
    },
  );

  // --- audit log (governance) --------------------------------------------
  server.tool(
    'audit_log_list',
    'List a space’s append-only audit trail (mutating actions), newest first.',
    {
      space: z.string().optional(),
      environment: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(
        await listAuditLog(ctx, spaceId, { environmentId: args.environment, limit: args.limit }),
      );
    },
  );

  // --- assets / media intelligence ---------------------------------------
  server.tool(
    'assets_list',
    'List assets (media library) in a space/environment.',
    { limit: z.number().int().positive().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAssets(ctx, scopeOf(args), { limit: args.limit }));
    },
  );

  server.tool(
    'asset_set_metadata',
    'Update an asset’s editorial metadata: localized alt text, focal point ' +
      '(x/y in 0..1 for smart cropping), taxonomy tag ids, and custom fields.',
    {
      id: z.string(),
      altText: z.record(z.string()).optional().describe('locale -> alt text'),
      tags: z.array(z.string()).optional().describe('taxonomy tag ids'),
      focalPoint: z.object({ x: z.number(), y: z.number() }).optional(),
      fields: z.record(z.any()).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setAssetMetadata(ctx, scopeOf(args), args.id, {
          altText: args.altText,
          tags: args.tags,
          focalPoint: args.focalPoint,
          fields: args.fields,
        }),
      );
    },
  );

  server.tool(
    'asset_usage',
    'List the entries that reference an asset (where it is used).',
    { id: z.string(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getAssetUsage(ctx, scopeOf(args), args.id));
    },
  );

  server.tool(
    'asset_generate_alt_text',
    'Suggest accessibility/SEO alt text for an image asset; set apply=true to ' +
      'write it to the asset metadata. Recorded in the agent cost ledger.',
    {
      id: z.string(),
      locale: z.string().optional(),
      context: z.string().optional().describe('extra context about how the image is used'),
      apply: z.boolean().optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await generateAltText(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          context: args.context,
          apply: args.apply,
        }),
      );
    },
  );

  server.tool(
    'asset_auto_tag',
    'Suggest taxonomy tags for an image asset (matching the existing vocabulary ' +
      'and proposing new names); set apply=true to create + assign them.',
    { id: z.string(), apply: z.boolean().optional(), ...scopeArgs },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await autoTagAsset(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  server.tool(
    'asset_transform_url',
    'Build a transformed-image URL for an asset (resize/crop/format/quality), ' +
      'anchored to the stored focal point when cropping.',
    {
      id: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
      format: z.enum(['jpg', 'png', 'webp', 'avif']).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      ...scopeArgs,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await transformAssetUrl(ctx, scopeOf(args), args.id, {
          width: args.width,
          height: args.height,
          fit: args.fit,
          format: args.format,
          quality: args.quality,
        }),
      );
    },
  );

  // --- branch compare/merge ----------------------------------------------
  server.tool(
    'environments_compare',
    'Diff two environments in a space (content types + entries that differ).',
    { source: z.string(), target: z.string(), space: z.string().optional() },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: args.source });
      return ok(await compareEnvironments(ctx, spaceId, args.source, args.target));
    },
  );

  server.tool(
    'environments_merge',
    'Apply selected content types/entries from a source environment into a target (additive).',
    {
      source: z.string(),
      target: z.string(),
      contentTypes: z.array(z.string()).optional(),
      entries: z.array(z.string()).optional(),
      space: z.string().optional(),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentManage, { spaceId, environmentId: args.target });
      return ok(
        await mergeEnvironments(ctx, spaceId, args.source, args.target, {
          contentTypes: args.contentTypes,
          entries: args.entries,
        }),
      );
    },
  );

  // --- environment aliases (blue/green) ----------------------------------
  server.tool(
    'environment_aliases_list',
    'List a space’s environment aliases (repointable pointers to environments).',
    { space: z.string().optional() },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await listEnvironmentAliases(ctx, spaceId));
    },
  );

  server.tool(
    'environment_alias_set',
    'Create or atomically repoint an environment alias at a target environment.',
    { alias: z.string(), targetEnvironmentId: z.string(), space: z.string().optional() },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await setEnvironmentAlias(ctx, spaceId, args.alias, args.targetEnvironmentId));
    },
  );

  server.tool(
    'environment_alias_delete',
    'Delete an environment alias (the target environment is untouched).',
    { alias: z.string(), space: z.string().optional() },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      await deleteEnvironmentAlias(ctx, spaceId, args.alias);
      return ok({ deleted: args.alias });
    },
  );

  return server;
}
