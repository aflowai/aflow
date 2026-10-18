/**
 * The one path to a memory embedding client (Plan 315 D12).
 *
 * A space has one embedding model, so every vector it stores shares a
 * geometry and search compares like with like. The model's key comes from the
 * space's chain — space, then tenant, then the space owner's personal keys.
 * Indexing runs with no one signed in, so the owner stands in for the user:
 * on the local edition that is the only person there is, and in a shared
 * space it is whoever answers for it. The deployment's own key pays only
 * off the local edition, and this is the only file that reads it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createAIClient,
  createDefaultModelCatalog,
  inferProviderForModelRef,
  type AIClient,
  type ModelDefinition,
  type ProviderConfig,
} from '@aflow/ai-client';
import { EMBEDDING_COLUMNS, createTenantContext, spaces, withTenantSchema } from '@aflow/database';
import {
  EditionIdSchema,
  getProviderDefinition,
  resolveRoleModel,
  type EmbeddingModelChoice,
  type EntityDirectives,
} from '@aflow/schemas';
import { ByokAiClientFactory, type ByokClientContext } from './byokAiClient.js';
import { CredentialResolver } from './resolver.js';
import { createProviderCredentialDbLoader } from './dbLoader.js';

export interface SpaceEmbeddingContext {
  tenantId: string;
  spaceId: string;
}

export interface EmbeddingModel {
  id: string;
  definition: ModelDefinition;
  dimensions: number;
  /** The vector column this model's output is stored in. */
  column: string;
}

export type SpaceEmbedding =
  | {
      state: 'ready';
      model: EmbeddingModel;
      pinned: boolean;
      funding: 'space' | 'platform';
      client: AIClient;
    }
  | {
      state: 'unconfigured';
      model: EmbeddingModel | null;
      pinned: boolean;
      reason: string;
    };

export interface MemoryEmbeddingResolver {
  resolve(ctx: SpaceEmbeddingContext): Promise<SpaceEmbedding>;
  /** Every embedding model the catalog offers, and whether this space can use it. */
  choices(ctx: SpaceEmbeddingContext): Promise<EmbeddingModelChoice[]>;
  /** Hold `modelId` as the space's model if it holds none yet. */
  pin(ctx: SpaceEmbeddingContext, modelId: string): Promise<void>;
  /** The catalog entry for a model ref, or null if it is no embedding model memory can store. */
  embeddingModel(modelRef: string): EmbeddingModel | null;
}

/** Where a space's embedding choice is kept. */
export interface EmbeddingSpaceStore {
  read(ctx: SpaceEmbeddingContext): Promise<{
    memoryEmbeddingModel: string | null;
    directives: EntityDirectives | null;
    ownerId: string | null;
  }>;
  /** Hold `modelId` as the space's model if it holds none yet. */
  pin(ctx: SpaceEmbeddingContext, modelId: string): Promise<void>;
}

export interface MemoryEmbeddingResolverOptions {
  factory?: Pick<ByokAiClientFactory, 'canResolveModel' | 'getClientForModel'>;
  spaces?: EmbeddingSpaceStore;
  /**
   * Whether the deployment's own provider keys may pay for embeddings. Read
   * from the edition when absent: never on the local edition, where there is
   * no platform and a key in the environment belongs to whoever set it.
   */
  platformFunding?: boolean;
  env?: NodeJS.ProcessEnv;
}

const PLATFORM_KEYS: Record<string, (env: NodeJS.ProcessEnv) => ProviderConfig | null> = {
  openai: (env) =>
    env['OPENAI_API_KEY']
      ? {
          apiKey: env['OPENAI_API_KEY'],
          ...(env['OPENAI_ORG_ID'] ? { organization: env['OPENAI_ORG_ID'] } : {}),
        }
      : null,
  google: (env) => (env['GEMINI_API_KEY'] ? { apiKey: env['GEMINI_API_KEY'] } : null),
  openrouter: (env) => (env['OPENROUTER_API_KEY'] ? { apiKey: env['OPENROUTER_API_KEY'] } : null),
};

function editionFundsEmbeddings(env: NodeJS.ProcessEnv): boolean {
  const edition = EditionIdSchema.safeParse(env['PHOENIX_EDITION']?.trim() || 'enterprise');
  return !(edition.success && edition.data === 'community-local');
}

function credentialChain(ctx: SpaceEmbeddingContext, ownerId: string | null): ByokClientContext {
  return { ...ctx, ...(ownerId ? { credentialOwnerId: ownerId } : {}) };
}

function providerName(providerId: string): string {
  return getProviderDefinition(providerId)?.displayName ?? providerId;
}

export function createMemoryEmbeddingResolver(
  db: PostgresJsDatabase,
  options: MemoryEmbeddingResolverOptions = {},
): MemoryEmbeddingResolver {
  const env = options.env ?? process.env;
  // Uncached: saving a key marks the space's waiting documents pending at
  // once, and a cached "no key" would turn them back to unconfigured on the
  // next cycle. No invalidation channel reaches every process that embeds.
  const factory =
    options.factory ??
    new ByokAiClientFactory(
      new CredentialResolver({ loader: createProviderCredentialDbLoader(db), cacheTtlMs: 0 }),
    );
  const platformFunding = options.platformFunding ?? editionFundsEmbeddings(env);
  const spaceStore = options.spaces ?? dbEmbeddingSpaceStore(db);
  const catalog = createDefaultModelCatalog();
  const platformClients = new Map<string, AIClient>();

  function embeddingModel(modelRef: string): EmbeddingModel | null {
    const definition = catalog.getModel(modelRef);
    const dimensions = definition?.embeddingDimensions;
    if (!definition?.capabilities.embedding || dimensions === undefined) return null;
    const column = EMBEDDING_COLUMNS[dimensions];
    if (!column) return null;
    return { id: definition.id, definition, dimensions, column };
  }

  const offered = catalog
    .listModels()
    .filter((m) => !m.deprecated)
    .map((m) => embeddingModel(m.id))
    .filter((m): m is EmbeddingModel => m !== null);

  function platformClient(providerId: string): AIClient | null {
    if (!platformFunding) return null;
    const cached = platformClients.get(providerId);
    if (cached) return cached;
    const config = PLATFORM_KEYS[providerId]?.(env);
    if (!config) return null;
    const client = createAIClient({
      providers: { [providerId]: config },
      defaultProvider: providerId as 'openai',
    });
    platformClients.set(providerId, client);
    return client;
  }

  async function clientFor(
    model: EmbeddingModel,
    chain: ByokClientContext,
  ): Promise<{ client: AIClient; funding: 'space' | 'platform' } | null> {
    if (await factory.canResolveModel(model.id, chain)) {
      const { client } = await factory.getClientForModel(model.id, chain);
      return { client, funding: 'space' };
    }
    const client = platformClient(model.definition.provider);
    return client ? { client, funding: 'platform' } : null;
  }

  /** One model per provider, the chat model's provider first. */
  function defaultCandidates(directives: EntityDirectives | null): EmbeddingModel[] {
    const chatProvider = inferProviderForModelRef(
      resolveRoleModel(directives?.modelDefaults, 'helmsman'),
    );
    const firstPerProvider = new Map<string, EmbeddingModel>();
    for (const model of offered) {
      if (!firstPerProvider.has(model.definition.provider)) {
        firstPerProvider.set(model.definition.provider, model);
      }
    }
    const candidates = [...firstPerProvider.values()];
    return [
      ...candidates.filter((m) => m.definition.provider === chatProvider),
      ...candidates.filter((m) => m.definition.provider !== chatProvider),
    ];
  }

  return {
    embeddingModel,

    async resolve(ctx) {
      const space = await spaceStore.read(ctx);
      const chain = credentialChain(ctx, space.ownerId);

      if (space.memoryEmbeddingModel) {
        const model = embeddingModel(space.memoryEmbeddingModel);
        if (!model) {
          return {
            state: 'unconfigured',
            model: null,
            pinned: true,
            reason: `This space's embedding model "${space.memoryEmbeddingModel}" is no longer offered. Choose another in Settings → Memory.`,
          };
        }
        const resolved = await clientFor(model, chain);
        if (!resolved) {
          const name = providerName(model.definition.provider);
          return {
            state: 'unconfigured',
            model,
            pinned: true,
            reason: `This space embeds with ${model.definition.displayName}, and no ${name} key is available to it. Add a ${name} key in Settings → Credentials, or choose another model in Settings → Memory.`,
          };
        }
        return { state: 'ready', model, pinned: true, ...resolved };
      }

      const candidates = defaultCandidates(space.directives);
      for (const model of candidates) {
        if (await factory.canResolveModel(model.id, chain)) {
          const { client } = await factory.getClientForModel(model.id, chain);
          return { state: 'ready', model, pinned: false, funding: 'space', client };
        }
      }
      for (const model of candidates) {
        const client = platformClient(model.definition.provider);
        if (client) return { state: 'ready', model, pinned: false, funding: 'platform', client };
      }

      const providers = [...new Set(candidates.map((m) => providerName(m.definition.provider)))];
      return {
        state: 'unconfigured',
        model: null,
        pinned: false,
        reason: `No provider with an embedding model has a key this space can use, so memory search is keyword-only. Add a key for ${providers.join(' or ')} in Settings → Credentials; a personal key counts when it belongs to the space's owner.`,
      };
    },

    async choices(ctx) {
      const chain = credentialChain(ctx, (await spaceStore.read(ctx)).ownerId);
      return Promise.all(
        offered.map(async (model) => {
          const available =
            (await factory.canResolveModel(model.id, chain)) ||
            platformClient(model.definition.provider) !== null;
          const pricePer1M = model.definition.pricing.embeddingPer1M ?? null;
          return {
            id: model.id,
            displayName: model.definition.displayName,
            provider: model.definition.provider,
            dimensions: model.dimensions,
            pricePer1M,
            available,
            unavailableReason: available
              ? null
              : `No ${providerName(model.definition.provider)} key this space can use.`,
          };
        }),
      );
    },

    async pin(ctx, modelId) {
      await spaceStore.pin(ctx, modelId);
    },
  };
}

function dbEmbeddingSpaceStore(db: PostgresJsDatabase): EmbeddingSpaceStore {
  const tenantContext = (ctx: SpaceEmbeddingContext) =>
    createTenantContext(ctx.tenantId as Parameters<typeof createTenantContext>[0]);
  return {
    async read(ctx) {
      const rows = await withTenantSchema(db, tenantContext(ctx), async (tx) =>
        tx
          .select({
            memoryEmbeddingModel: spaces.memoryEmbeddingModel,
            directives: spaces.directives,
            ownerId: spaces.ownerId,
          })
          .from(spaces)
          .where(eq(spaces.id, ctx.spaceId))
          .limit(1),
      );
      return rows[0] ?? { memoryEmbeddingModel: null, directives: null, ownerId: null };
    },
    async pin(ctx, modelId) {
      await withTenantSchema(db, tenantContext(ctx), async (tx) => {
        await tx
          .update(spaces)
          .set({ memoryEmbeddingModel: modelId })
          .where(and(eq(spaces.id, ctx.spaceId), isNull(spaces.memoryEmbeddingModel)));
      });
    },
  };
}
