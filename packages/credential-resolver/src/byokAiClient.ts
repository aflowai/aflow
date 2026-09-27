/**
 * BYOK AI client factory — one shared implementation of "resolve the
 * caller's credential for this model's provider and build a client with it,
 * never falling back to platform environment keys". Platform env keys are
 * reserved for the memory-embedding infrastructure paths.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createAIClient,
  inferProviderForModelRef,
  type AIClient,
  type ProviderConfig,
} from '@aflow/ai-client';
import { CredentialResolver } from './resolver.js';
import { createProviderCredentialDbLoader } from './dbLoader.js';
import { credentialMissingMessage } from './errors.js';

const CLIENT_CACHE_TTL_MS = 300_000;

const BYOK_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter', 'fireworks', 'xai']);

/**
 * Provider for a model ref, narrowed to those a caller can bring a key for.
 *
 * The answer itself comes from the catalog's shared resolver — there is one
 * rule for reading a model ref, and a second copy of it here routed an
 * off-catalog Fireworks id to the OpenRouter key. What this adds is the BYOK
 * narrowing: a provider nobody can hold a credential for is no answer here.
 */
export function byokProviderForModelRef(ref: string): string | null {
  const provider = inferProviderForModelRef(ref);
  return provider && BYOK_PROVIDERS.has(provider) ? provider : null;
}

export interface ByokClientContext {
  tenantId: string;
  spaceId: string;
  /**
   * The human whose user-scope keys participate in resolution. Absent for
   * space-owned background work (eval grading) — the chain then starts at
   * space scope.
   */
  credentialOwnerId?: string;
}

export class ByokCredentialError extends Error {
  constructor(
    message: string,
    readonly providerId: string | null,
  ) {
    super(message);
    this.name = 'ByokCredentialError';
  }
}

export class ByokAiClientFactory {
  private cache = new Map<string, { client: AIClient; expiresAt: number }>();

  constructor(private resolver: CredentialResolver) {}

  /** Whether `model`'s provider resolves a credential in this context. */
  async canResolveModel(model: string, ctx: ByokClientContext): Promise<boolean> {
    const providerId = byokProviderForModelRef(model);
    if (!providerId) return false;
    const resolved = await this.resolver.resolve(providerId, {
      tenantId: ctx.tenantId,
      credentialOwnerId: ctx.credentialOwnerId ?? '',
      spaceId: ctx.spaceId,
    });
    return resolved !== null;
  }

  /** Resolve the credential for `model`'s provider and return a client bound to it. */
  async getClientForModel(
    model: string,
    ctx: ByokClientContext,
  ): Promise<{ client: AIClient; providerId: string }> {
    const providerId = byokProviderForModelRef(model);
    if (!providerId) {
      throw new ByokCredentialError(
        `Cannot determine the provider for model "${model}" — use a catalog model id or alias.`,
        null,
      );
    }
    const resolved = await this.resolver.resolve(providerId, {
      tenantId: ctx.tenantId,
      credentialOwnerId: ctx.credentialOwnerId ?? '',
      spaceId: ctx.spaceId,
    });
    if (!resolved) {
      throw new ByokCredentialError(credentialMissingMessage(providerId), providerId);
    }

    const cacheKey = `${resolved.credentialId}:${resolved.updatedAt}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return { client: hit.client, providerId };

    const providerConfig: ProviderConfig = { apiKey: resolved.secrets['api_key'] ?? '' };
    if (providerId === 'openai' && resolved.config['org_id']) {
      providerConfig.organization = resolved.config['org_id'];
    }
    const client = createAIClient({
      providers: { [providerId]: providerConfig },
      defaultProvider: providerId as 'openai',
    });
    this.cache.set(cacheKey, { client, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });
    return { client, providerId };
  }
}

export function createByokAiClientFactory(db: PostgresJsDatabase): ByokAiClientFactory {
  return new ByokAiClientFactory(
    new CredentialResolver({ loader: createProviderCredentialDbLoader(db) }),
  );
}
