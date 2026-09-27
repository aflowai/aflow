import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialResolver } from './resolver.js';
import type { CredentialRow, CredentialContext } from './types.js';

// Mock the database decryption — just decode JSON from the encrypted string
vi.mock('@aflow/database', () => ({
  decryptCredentialAsync: async (encrypted: string) => {
    // In tests, "encrypted" is just the raw JSON string
    return encrypted;
  },
}));

const ctx: CredentialContext = {
  tenantId: 'tenant-1',
  credentialOwnerId: 'user-1',
  spaceId: 'space-1',
};

function makeRow(
  scope: string,
  scopeId: string,
  overrides?: Partial<CredentialRow>,
): CredentialRow {
  return {
    id: `cred-${scope}-${scopeId}`,
    providerId: 'openai',
    scope,
    scopeId,
    encryptedSecrets: JSON.stringify({ api_key: `sk-${scope}` }),
    configJson: { org_id: `org-${scope}` },
    status: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('CredentialResolver', () => {
  let loader: ReturnType<typeof vi.fn>;
  let resolver: CredentialResolver;

  beforeEach(() => {
    loader = vi.fn();
    resolver = new CredentialResolver({ loader, cacheTtlMs: 100 });
  });

  it('returns null when no credentials exist', async () => {
    loader.mockResolvedValue([]);
    const result = await resolver.resolve('openai', ctx);
    expect(result).toBeNull();
  });

  it('resolves user-scope credential first', async () => {
    loader.mockResolvedValue([
      makeRow('tenant', 'tenant-1'),
      makeRow('space', 'space-1'),
      makeRow('user', 'user-1'),
    ]);

    const result = await resolver.resolve('openai', ctx);
    expect(result).not.toBeNull();
    expect(result!.scope).toBe('user');
    expect(result!.scopeId).toBe('user-1');
    expect(result!.secrets['api_key']).toBe('sk-user');
    expect(result!.config['org_id']).toBe('org-user');
    expect(result!.credentialId).toBe('cred-user-user-1');
  });

  it('falls through to space when no user credential', async () => {
    loader.mockResolvedValue([makeRow('tenant', 'tenant-1'), makeRow('space', 'space-1')]);

    const result = await resolver.resolve('openai', ctx);
    expect(result!.scope).toBe('space');
    expect(result!.secrets['api_key']).toBe('sk-space');
  });

  it('falls through to tenant when no user or space credential', async () => {
    loader.mockResolvedValue([makeRow('tenant', 'tenant-1')]);

    const result = await resolver.resolve('openai', ctx);
    expect(result!.scope).toBe('tenant');
    expect(result!.secrets['api_key']).toBe('sk-tenant');
  });

  it('does NOT fall through when user credential exists (even with different user)', async () => {
    // User-2 has a credential but user-1 (the credentialOwner) does not
    loader.mockResolvedValue([makeRow('user', 'user-2'), makeRow('tenant', 'tenant-1')]);

    const result = await resolver.resolve('openai', ctx);
    // Should fall through user (user-1 not found), skip user-2, land on tenant
    expect(result!.scope).toBe('tenant');
  });

  it('caches loader results', async () => {
    loader.mockResolvedValue([makeRow('tenant', 'tenant-1')]);

    await resolver.resolve('openai', ctx);
    await resolver.resolve('openai', ctx);

    // Loader should be called only once due to cache
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('invalidate clears cache for specific provider', async () => {
    loader.mockResolvedValue([makeRow('tenant', 'tenant-1')]);

    await resolver.resolve('openai', ctx);
    resolver.invalidate('tenant-1', 'openai');
    await resolver.resolve('openai', ctx);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidate without providerId clears all tenant cache', async () => {
    loader.mockResolvedValue([makeRow('tenant', 'tenant-1')]);

    await resolver.resolve('openai', ctx);
    resolver.invalidate('tenant-1');
    await resolver.resolve('openai', ctx);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('throws for unknown provider', async () => {
    await expect(resolver.resolve('unknown-provider', ctx)).rejects.toThrow(
      'Unknown provider: unknown-provider',
    );
  });

  it('coerces config values to strings', async () => {
    loader.mockResolvedValue([
      makeRow('tenant', 'tenant-1', {
        configJson: { port: 587, enabled: true },
      }),
    ]);

    const result = await resolver.resolve('openai', ctx);
    expect(result!.config['port']).toBe('587');
    expect(result!.config['enabled']).toBe('true');
  });
});
