import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantIntegrationPolicy } from '../integrationPolicy.js';

const mockGetPolicy = vi.fn<() => Promise<TenantIntegrationPolicy>>();

vi.mock('../integrationPolicy.js', async () => {
  const actual =
    await vi.importActual<typeof import('../integrationPolicy.js')>('../integrationPolicy.js');
  return {
    ...actual,
    getTenantIntegrationPolicy: () => mockGetPolicy(),
  };
});

const { buildCatalogGrantMap, catalogGrantKey, createTenantPolicyCache } =
  await import('../tenantPolicyCache.js');

const DB = {} as PostgresJsDatabase;
const TENANT = 'tenant-1';

const ALLOWLIST_POLICY: TenantIntegrationPolicy = {
  mode: 'allowlist',
  allowlist: [{ kind: 'api', hostPattern: 'api.allowed.example' }],
};

beforeEach(() => {
  mockGetPolicy.mockReset();
});

describe('createTenantPolicyCache', () => {
  it('reads through once within the TTL', async () => {
    mockGetPolicy.mockResolvedValue(ALLOWLIST_POLICY);
    const cache = createTenantPolicyCache({ ttlMs: 60_000 });
    expect(await cache.load(DB, TENANT)).toEqual(ALLOWLIST_POLICY);
    expect(await cache.load(DB, TENANT)).toEqual(ALLOWLIST_POLICY);
    expect(mockGetPolicy).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    mockGetPolicy.mockResolvedValue(ALLOWLIST_POLICY);
    const cache = createTenantPolicyCache({ ttlMs: 0 });
    await cache.load(DB, TENANT);
    await cache.load(DB, TENANT);
    expect(mockGetPolicy).toHaveBeenCalledTimes(2);
  });

  it('keeps the last-known-good policy when a later read fails', async () => {
    mockGetPolicy.mockResolvedValueOnce(ALLOWLIST_POLICY);
    const onLoadError = vi.fn();
    const cache = createTenantPolicyCache({ ttlMs: 0, onLoadError });
    expect(await cache.load(DB, TENANT)).toEqual(ALLOWLIST_POLICY);

    mockGetPolicy.mockRejectedValueOnce(new Error('db down'));
    expect(await cache.load(DB, TENANT)).toEqual(ALLOWLIST_POLICY);
    expect(onLoadError).toHaveBeenCalledWith(TENANT, expect.any(Error));
  });

  it('defaults to open only when nothing was ever loaded', async () => {
    mockGetPolicy.mockRejectedValue(new Error('db down'));
    const cache = createTenantPolicyCache({ ttlMs: 0 });
    expect(await cache.load(DB, TENANT)).toEqual({ mode: 'open', allowlist: [] });
  });

  it('treats a missing db as open without touching the loader', async () => {
    const cache = createTenantPolicyCache();
    expect(await cache.load(undefined, TENANT)).toEqual({ mode: 'open', allowlist: [] });
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });

  it('peek returns the last loaded policy without a read', async () => {
    const cache = createTenantPolicyCache({ ttlMs: 60_000 });
    expect(cache.peek(TENANT)).toBeUndefined();
    mockGetPolicy.mockResolvedValue(ALLOWLIST_POLICY);
    await cache.load(DB, TENANT);
    expect(cache.peek(TENANT)).toEqual(ALLOWLIST_POLICY);
    expect(mockGetPolicy).toHaveBeenCalledTimes(1);
  });

  it('honors a per-call ttl override', async () => {
    mockGetPolicy.mockResolvedValue(ALLOWLIST_POLICY);
    const cache = createTenantPolicyCache({ ttlMs: 60_000 });
    await cache.load(DB, TENANT);
    await cache.load(DB, TENANT, { ttlMs: 0 });
    expect(mockGetPolicy).toHaveBeenCalledTimes(2);
  });
});

describe('buildCatalogGrantMap', () => {
  it('maps grants to flattened hosts keyed by catalogGrantKey', async () => {
    const tx = {
      execute: () =>
        Promise.resolve([
          {
            artifact_type: 'api_definition',
            artifact_key: 'github',
            host_manifest_json: {
              apiHosts: ['api.github.com'],
              oauthHosts: ['github.com'],
              mcpHosts: [],
              redirectHosts: ['objects.githubusercontent.com'],
            },
          },
        ]),
    } as unknown as PostgresJsDatabase;
    const map = await buildCatalogGrantMap(tx, 'space-1');
    expect(map.get(catalogGrantKey('api_definition', 'github'))).toEqual([
      'api.github.com',
      'github.com',
      'objects.githubusercontent.com',
    ]);
  });

  it('yields an empty map when the provenance tables are missing', async () => {
    const tx = {
      execute: () => Promise.reject(new Error('relation "store_installs" does not exist')),
    } as unknown as PostgresJsDatabase;
    const map = await buildCatalogGrantMap(tx, 'space-1');
    expect(map.size).toBe(0);
  });
});
