import { decryptCredentialAsync } from '@aflow/database';
import { getProviderDefinition } from '@aflow/schemas';
import type {
  CredentialContext,
  CredentialLoader,
  CredentialRow,
  ResolvedProvider,
} from './types.js';
import type { CredentialScope } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  rows: CredentialRow[];
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// CredentialResolver
// ---------------------------------------------------------------------------

export interface CredentialResolverOptions {
  loader: CredentialLoader;
  cacheTtlMs?: number;
}

export class CredentialResolver {
  private readonly loader: CredentialLoader;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: CredentialResolverOptions) {
    this.loader = options.loader;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Resolve all fields for a provider from the most specific scope.
   * Returns null if no credential exists at any scope.
   */
  async resolve(providerId: string, ctx: CredentialContext): Promise<ResolvedProvider | null> {
    const definition = getProviderDefinition(providerId);
    if (!definition) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const rows = await this.loadRows(ctx.tenantId, providerId);

    // Walk the scope chain: user → space → tenant
    const scopeChain: Array<{ scope: CredentialScope; scopeId: string }> = [
      { scope: 'user', scopeId: ctx.credentialOwnerId },
      { scope: 'space', scopeId: ctx.spaceId },
      { scope: 'tenant', scopeId: ctx.tenantId },
    ];

    for (const { scope, scopeId } of scopeChain) {
      const row = rows.find((r) => r.scope === scope && r.scopeId === scopeId);
      if (row) {
        return this.decryptRow(row);
      }
    }

    return null;
  }

  /**
   * Invalidate cached rows for a tenant+provider pair.
   * Called on credential mutation via Redis Pub/Sub.
   */
  invalidate(tenantId: string, providerId?: string): void {
    if (providerId) {
      this.cache.delete(this.cacheKey(tenantId, providerId));
    } else {
      // Invalidate all providers for the tenant
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${tenantId}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /** Clear all cached entries. */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private async loadRows(tenantId: string, providerId: string): Promise<CredentialRow[]> {
    const key = this.cacheKey(tenantId, providerId);
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.rows;
    }

    const rows = await this.loader(tenantId, providerId);

    this.cache.set(key, {
      rows,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return rows;
  }

  private async decryptRow(row: CredentialRow): Promise<ResolvedProvider> {
    const decryptedJson = await decryptCredentialAsync(row.encryptedSecrets);
    const secrets = JSON.parse(decryptedJson) as Record<string, string>;

    // Coerce config values to strings
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.configJson)) {
      if (v != null) {
        config[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }

    return {
      secrets,
      config,
      scope: row.scope as CredentialScope,
      scopeId: row.scopeId,
      credentialId: row.id,
      updatedAt: row.updatedAt,
    };
  }

  private cacheKey(tenantId: string, providerId: string): string {
    return `${tenantId}:${providerId}`;
  }
}
