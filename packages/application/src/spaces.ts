import { type LocaleCode, NotFoundError, type Scope, ValidationError } from '@cw/domain';
import type { SpaceConfig } from '@cw/ports';
import type { AppContext } from './context.js';

export interface CreateSpaceInput {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: LocaleCode;
  readonly locales?: readonly LocaleCode[];
  readonly fallbacks?: Record<LocaleCode, LocaleCode | null>;
  /** Environments to create alongside the space. Defaults to ["main"]. */
  readonly environments?: readonly string[];
}

/**
 * Provisions a space with its locales and one or more environments. This is the
 * entry point that lets the platform be set up over the API instead of by hand.
 */
export async function createSpace(ctx: AppContext, input: CreateSpaceInput): Promise<SpaceConfig> {
  const locales = input.locales?.length ? input.locales : [input.defaultLocale];
  if (!locales.includes(input.defaultLocale)) {
    throw new ValidationError([
      { field: 'defaultLocale', message: 'defaultLocale must be included in locales' },
    ]);
  }
  const config: SpaceConfig = {
    spaceId: input.spaceId,
    name: input.name,
    defaultLocale: input.defaultLocale,
    locales,
    fallbacks: input.fallbacks,
  };
  await ctx.store.spaces.create(config);
  const environments = input.environments?.length ? input.environments : ['main'];
  for (const env of environments) {
    await ctx.store.spaces.createEnvironment(input.spaceId, env, env);
  }
  return config;
}

/** Reads a space's configuration (locales, default locale, fallbacks). */
export async function getSpaceConfig(ctx: AppContext, scope: Scope): Promise<SpaceConfig> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/** Adds an environment (branch) to an existing space. */
export async function createEnvironment(
  ctx: AppContext,
  spaceId: string,
  environmentId: string,
  name?: string,
): Promise<void> {
  await ctx.store.spaces.createEnvironment(spaceId, environmentId, name ?? environmentId);
}

/** Lists a space's environments (branches). */
export async function listEnvironments(ctx: AppContext, spaceId: string) {
  return ctx.store.spaces.listEnvironments(spaceId);
}
