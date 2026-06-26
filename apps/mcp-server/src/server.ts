import {
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  draftEntry,
  getContentType,
  getPreviewEntry,
  getRelease,
  listContentTypes,
  listPreviewEntries,
  listReleases,
  publishContentType,
  publishEntry,
  publishRelease,
  scheduleAction,
  semanticSearch,
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

  return server;
}
