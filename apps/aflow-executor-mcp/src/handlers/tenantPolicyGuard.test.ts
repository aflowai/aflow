import { describe, it, expect } from 'vitest';
import { catalogGrantKey, type TenantIntegrationPolicy } from '@aflow/database';
import { SsrfBlockedError } from '@aflow/network-safety';
import {
  assertTenantPolicyPermitsConnect,
  assertTenantPolicyPermitsTokenEndpoint,
  tenantPolicyPermittedHosts,
  type McpTenantGuardRef,
} from './tenantPolicyGuard.js';
import { getMcpSpaceStores, type McpHandlerStores } from './types.js';

const TENANT = 'tenant-1';
const SPACE = 'space-a';

const GUARD: McpTenantGuardRef = {
  tenantId: TENANT,
  spaceId: SPACE,
  serverId: 'kaggle',
  bindingId: 'kaggle-default',
};

function stores(policy?: TenantIntegrationPolicy): McpHandlerStores {
  return {
    bySpace: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: {
      load: () => Promise.resolve(policy ?? { mode: 'open', allowlist: [] }),
      peek: () => policy,
    },
  };
}

describe('assertTenantPolicyPermitsConnect', () => {
  it('is a no-op without a guard (raw dev path)', () => {
    const s = stores({ mode: 'allowlist', allowlist: [] });
    expect(() =>
      assertTenantPolicyPermitsConnect(s, 'https://anything.example/mcp', null),
    ).not.toThrow();
  });

  it('is a no-op in open mode and when no policy is cached', () => {
    expect(() =>
      assertTenantPolicyPermitsConnect(
        stores({ mode: 'open', allowlist: [] }),
        'https://anything.example/mcp',
        GUARD,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantPolicyPermitsConnect(stores(), 'https://anything.example/mcp', GUARD),
    ).not.toThrow();
  });

  it('blocks a server host outside the mcp allowlist and grants, with the admin fix path', () => {
    const s = stores({
      mode: 'allowlist',
      allowlist: [{ kind: 'api', hostPattern: 'anything.example' }],
    });
    try {
      assertTenantPolicyPermitsConnect(s, 'https://anything.example/mcp', GUARD);
      expect.unreachable('expected a policy block');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).kind).toBe('allowlist-host');
      expect((err as SsrfBlockedError).message).toContain('tenant integration policy');
      expect((err as SsrfBlockedError).message).toContain('Tenant Admin → Integrations Policy');
    }
  });

  it('permits a host covered by an mcp allowlist row', () => {
    const s = stores({
      mode: 'allowlist',
      allowlist: [{ kind: 'mcp', hostPattern: '*.kaggle.com' }],
    });
    expect(() =>
      assertTenantPolicyPermitsConnect(s, 'https://www.kaggle.com/mcp', GUARD),
    ).not.toThrow();
  });

  it('permits a host covered by the captured catalog grant for the server or binding', () => {
    const s = stores({ mode: 'allowlist', allowlist: [] });
    const slice = getMcpSpaceStores(s, TENANT, SPACE);
    slice.catalogGrantStore.set(catalogGrantKey('mcp_definition', 'kaggle'), ['www.kaggle.com']);
    expect(() =>
      assertTenantPolicyPermitsConnect(s, 'https://www.kaggle.com/mcp', GUARD),
    ).not.toThrow();
    expect(() =>
      assertTenantPolicyPermitsConnect(s, 'https://elsewhere.example/mcp', GUARD),
    ).toThrow(SsrfBlockedError);
  });
});

describe('tenantPolicyPermittedHosts', () => {
  it('returns null in open mode / with no guard, and the union in allowlist mode', () => {
    expect(tenantPolicyPermittedHosts(stores({ mode: 'open', allowlist: [] }), GUARD)).toBeNull();
    expect(
      tenantPolicyPermittedHosts(stores({ mode: 'allowlist', allowlist: [] }), null),
    ).toBeNull();

    const s = stores({
      mode: 'allowlist',
      allowlist: [{ kind: 'mcp', hostPattern: '*.kaggle.com' }],
    });
    const slice = getMcpSpaceStores(s, TENANT, SPACE);
    slice.catalogGrantStore.set(catalogGrantKey('mcp_binding', 'kaggle-default'), [
      'auth.kaggle.example',
    ]);
    expect(tenantPolicyPermittedHosts(s, GUARD)).toEqual(['*.kaggle.com', 'auth.kaggle.example']);
  });
});

describe('assertTenantPolicyPermitsTokenEndpoint', () => {
  it('is a no-op without permitted hosts (open mode)', () => {
    expect(() =>
      assertTenantPolicyPermitsTokenEndpoint(null, 'https://auth.example/token'),
    ).not.toThrow();
  });

  it('blocks a token endpoint host outside the permitted set, with the admin fix path', () => {
    try {
      assertTenantPolicyPermitsTokenEndpoint(['*.kaggle.com'], 'https://auth.example/token');
      expect.unreachable('expected a policy block');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).kind).toBe('allowlist-host');
      expect((err as SsrfBlockedError).message).toContain('tenant integration policy');
      expect((err as SsrfBlockedError).message).toContain('Tenant Admin → Integrations Policy');
    }
  });

  it('permits a covered token endpoint host', () => {
    expect(() =>
      assertTenantPolicyPermitsTokenEndpoint(['auth.example'], 'https://auth.example/token'),
    ).not.toThrow();
  });
});
