import { describe, expect, it } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createDefaultModelCatalog, type AIClient } from '@aflow/ai-client';
import { EMBEDDING_COLUMNS } from '@aflow/database';
import type { EntityDirectives } from '@aflow/schemas';
import {
  createMemoryEmbeddingResolver,
  type EmbeddingSpaceStore,
  type MemoryEmbeddingResolverOptions,
} from './memoryEmbedding.js';

const ctx = { tenantId: 't-1', spaceId: 's-1' };

const OWNER = 'u-owner';

function spaceStore(
  memoryEmbeddingModel: string | null,
  directives: EntityDirectives | null = null,
): EmbeddingSpaceStore & { pinned: string[] } {
  const pinned: string[] = [];
  return {
    pinned,
    read: () => Promise.resolve({ memoryEmbeddingModel, directives, ownerId: OWNER }),
    pin: (_ctx, modelId) => {
      pinned.push(modelId);
      return Promise.resolve();
    },
  };
}

/**
 * A credential chain holding shared keys for `providers`, and personal keys
 * (`user:<provider>`) that resolve only for the space owner.
 */
function keys(...providers: string[]): NonNullable<MemoryEmbeddingResolverOptions['factory']> {
  const providerOf = (model: string) => createDefaultModelCatalog().getModel(model)?.provider;
  return {
    canResolveModel: (model, chain) =>
      Promise.resolve(
        providers.includes(providerOf(model) ?? '') ||
          (chain.credentialOwnerId === OWNER &&
            providers.includes(`user:${providerOf(model) ?? ''}`)),
      ),
    getClientForModel: (model) =>
      Promise.resolve({ client: {} as AIClient, providerId: providerOf(model) ?? '' }),
  };
}

function resolver(options: MemoryEmbeddingResolverOptions) {
  return createMemoryEmbeddingResolver({} as PostgresJsDatabase, {
    platformFunding: false,
    env: {},
    ...options,
  });
}

describe('a space that chose a model', () => {
  it('embeds with it through the space chain', async () => {
    const result = await resolver({
      spaces: spaceStore('gemini-embedding-001'),
      factory: keys('google', 'openai'),
    }).resolve(ctx);
    expect(result).toMatchObject({
      state: 'ready',
      pinned: true,
      funding: 'space',
      model: { id: 'gemini-embedding-001', dimensions: 1536, column: 'embedding_1536' },
    });
  });

  it('is unconfigured, naming the provider, when no key for it reaches the space', async () => {
    const result = await resolver({
      spaces: spaceStore('gemini-embedding-001'),
      factory: keys('openai'),
    }).resolve(ctx);
    expect(result.state).toBe('unconfigured');
    expect(result.state === 'unconfigured' && result.reason).toMatch(/Google/);
  });

  it('never falls through to another provider, whose vectors would not compare', async () => {
    const result = await resolver({
      spaces: spaceStore('text-embedding-3-small'),
      factory: keys('google'),
    }).resolve(ctx);
    expect(result).toMatchObject({
      state: 'unconfigured',
      model: { id: 'text-embedding-3-small' },
    });
  });

  it('is unconfigured when its model has left the catalog', async () => {
    const result = await resolver({
      spaces: spaceStore('no-such-embedder'),
      factory: keys('openai'),
    }).resolve(ctx);
    expect(result).toMatchObject({ state: 'unconfigured', model: null, pinned: true });
  });
});

describe('a space that has not chosen', () => {
  it("defaults to the chat provider's embedding model when the space holds its key", async () => {
    const result = await resolver({
      spaces: spaceStore(null, {
        modelDefaults: { helmsman: 'gemini-3.1-pro-preview' },
      } as EntityDirectives),
      factory: keys('openai', 'google'),
    }).resolve(ctx);
    expect(result).toMatchObject({
      state: 'ready',
      pinned: false,
      model: { id: 'gemini-embedding-001' },
    });
  });

  it('defaults to any provider with a key otherwise', async () => {
    const result = await resolver({ spaces: spaceStore(null), factory: keys('openai') }).resolve(
      ctx,
    );
    expect(result).toMatchObject({ state: 'ready', model: { id: 'text-embedding-3-small' } });
  });

  it('is unconfigured with no key, and says whose personal key would count', async () => {
    const result = await resolver({ spaces: spaceStore(null), factory: keys() }).resolve(ctx);
    expect(result.state).toBe('unconfigured');
    expect(result.state === 'unconfigured' && result.reason).toMatch(/space's owner/);
  });

  it("embeds with the space owner's personal key", async () => {
    const result = await resolver({
      spaces: spaceStore(null),
      factory: keys('user:google'),
    }).resolve(ctx);
    expect(result).toMatchObject({
      state: 'ready',
      funding: 'space',
      model: { id: 'gemini-embedding-001' },
    });
  });
});

describe("the deployment's own key", () => {
  const env = { OPENAI_API_KEY: 'sk-platform' };

  it('pays where the edition funds embeddings', async () => {
    const result = await resolver({
      spaces: spaceStore(null),
      factory: keys(),
      platformFunding: true,
      env,
    }).resolve(ctx);
    expect(result).toMatchObject({ state: 'ready', funding: 'platform' });
  });

  it('is never read on the local edition', async () => {
    const result = createMemoryEmbeddingResolver({} as PostgresJsDatabase, {
      spaces: spaceStore(null),
      factory: keys(),
      env: { ...env, PHOENIX_EDITION: 'community-local' },
    });
    expect((await result.resolve(ctx)).state).toBe('unconfigured');
    expect((await result.choices(ctx)).every((c) => !c.available)).toBe(true);
  });

  it("yields to the space's own key", async () => {
    const result = await resolver({
      spaces: spaceStore(null),
      factory: keys('openai'),
      platformFunding: true,
      env,
    }).resolve(ctx);
    expect(result).toMatchObject({ funding: 'space' });
  });
});

describe('the catalog', () => {
  it('gives every embedding model a size memory has a column for', () => {
    const embedders = createDefaultModelCatalog()
      .listModels()
      .filter((m) => m.capabilities.embedding);
    expect(embedders.length).toBeGreaterThan(0);
    for (const model of embedders) {
      expect(model.embeddingDimensions, model.id).toBeDefined();
      expect(EMBEDDING_COLUMNS[model.embeddingDimensions!], model.id).toBeDefined();
    }
  });

  it('offers only models whose provider the space can reach', async () => {
    const choices = await resolver({ spaces: spaceStore(null), factory: keys('google') }).choices(
      ctx,
    );
    expect(choices.filter((c) => c.available).map((c) => c.provider)).toEqual(['google']);
    expect(choices.find((c) => !c.available)?.unavailableReason).toMatch(/OpenAI/);
  });
});
