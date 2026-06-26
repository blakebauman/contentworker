import type { ContentType, FieldDefinition } from '@cw/domain';
import {
  GraphQLBoolean,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';

/** An entry rendered (locale-flattened, links resolved) by the resolvers. */
export interface ResolvedEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/** Data access the generated schema needs — bound to a space/environment. */
export interface DeliveryResolvers {
  entry(contentType: string, id: string, locale?: string): Promise<ResolvedEntry | null>;
  collection(
    contentType: string,
    args: { locale?: string; limit?: number; skip?: number },
  ): Promise<ResolvedEntry[]>;
  asset(id: string, locale?: string): Promise<unknown | null>;
  search(query: string, topK?: number): Promise<SearchHit[]>;
}

/** Arbitrary-JSON scalar — used for rich text, JSON, location, and link fields. */
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value (rich text, JSON, location, or resolved link).',
  serialize: (v) => v,
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function scalarFor(field: FieldDefinition): GraphQLOutputType {
  switch (field.type) {
    case 'Integer':
      return GraphQLInt;
    case 'Number':
      return GraphQLFloat;
    case 'Boolean':
      return GraphQLBoolean;
    case 'Symbol':
    case 'Text':
    case 'Date':
      return GraphQLString;
    default:
      // RichText, Location, JSON, Link, Array → JSON (links arrive resolved/embedded).
      return JSONScalar;
  }
}

/**
 * Builds a GraphQL Delivery schema from a set of published content types. Each
 * content type becomes an object type (scalar fields typed; rich/link fields as
 * JSON), with `<type>` and `<type>Collection` root queries plus `asset` and
 * `search`. Field values come from the resolver-rendered entry, so locale
 * flattening and reference resolution are reused, not reimplemented.
 */
export function buildDeliverySchema(
  contentTypes: readonly ContentType[],
  resolvers: DeliveryResolvers,
): GraphQLSchema {
  const sysType = new GraphQLObjectType({
    name: 'Sys',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID), resolve: (s: ResolvedEntry) => s.id },
      contentType: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (s: ResolvedEntry) => s.contentType,
      },
      publishedAt: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (s: ResolvedEntry) => s.publishedAt,
      },
    },
  });

  const searchHitType = new GraphQLObjectType({
    name: 'SearchHit',
    fields: {
      entryId: { type: new GraphQLNonNull(GraphQLID) },
      score: { type: new GraphQLNonNull(GraphQLFloat) },
      snippet: { type: new GraphQLNonNull(GraphQLString) },
    },
  });

  const localeArg = { locale: { type: GraphQLString } };
  const query: GraphQLFieldConfigMap<unknown, unknown> = {};

  for (const ct of contentTypes) {
    const fields: GraphQLFieldConfigMap<ResolvedEntry, unknown> = {
      _sys: { type: new GraphQLNonNull(sysType), resolve: (s) => s },
    };
    for (const f of ct.fields) {
      fields[f.apiId] = { type: scalarFor(f), resolve: (s) => s.fields[f.apiId] };
    }
    const objectType = new GraphQLObjectType<ResolvedEntry>({ name: cap(ct.apiId), fields });

    query[ct.apiId] = {
      type: objectType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...localeArg },
      resolve: (_root, args: { id: string; locale?: string }) =>
        resolvers.entry(ct.apiId, args.id, args.locale),
    };
    query[`${ct.apiId}Collection`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
      args: { ...localeArg, limit: { type: GraphQLInt }, skip: { type: GraphQLInt } },
      resolve: (_root, args: { locale?: string; limit?: number; skip?: number }) =>
        resolvers.collection(ct.apiId, args),
    };
  }

  query.asset = {
    type: JSONScalar,
    args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...localeArg },
    resolve: (_root, args: { id: string; locale?: string }) =>
      resolvers.asset(args.id, args.locale),
  };
  query.search = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(searchHitType))),
    args: { query: { type: new GraphQLNonNull(GraphQLString) }, topK: { type: GraphQLInt } },
    resolve: (_root, args: { query: string; topK?: number }) =>
      resolvers.search(args.query, args.topK),
  };

  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: query }) });
}

export { JSONScalar };
