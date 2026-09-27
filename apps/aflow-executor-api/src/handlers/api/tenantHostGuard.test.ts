import { describe, it, expect } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { catalogGrantKey, type TenantIntegrationPolicy } from '@aflow/database';
import { assertTenantPolicyPermits } from './execution.js';
import { attachTenantHostGuard } from './resolution.js';
import {
  ApiExecutionError,
  spaceScopeKey,
  type ApiHandlerStores,
  type ResolvedCall,
} from './types.js';

const TENANT = 'tenant-1';
const SPACE = 'space-a';

function ctx(spaceId?: string): ExecutorContext {
  return {
    job: { tenantId: TENANT, ...(spaceId ? { spaceId } : {}) },
  } as unknown as ExecutorContext;
}

function stores(policy?: TenantIntegrationPolicy): ApiHandlerStores {
  return {
    definitionStore: new Map(),
    invalidDefinitions: new Map(),
    bindingStore: new Map(),
    credentialStore: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: {
      load: () => Promise.resolve(policy ?? { mode: 'open', allowlist: [] }),
      peek: () => policy,
    },
    catalogGrantStore: new Map(),
    simulationStore: new Map(),
    simulationLoadPromises: new Map(),
    simulationSnapshotStore: new Map(),
  };
}

function resolved(overrides: Partial<ResolvedCall> = {}): ResolvedCall {
  return {
    url: 'https://api.example.com/v1',
    method: 'GET',
    headers: {},
    body: undefined,
    egressPolicy: {
      allowedHosts: ['api.example.com', 'evil.example'],
      allowedMethods: ['GET', 'POST'],
      maxRequestBodyBytes: 1_048_576,
      maxResponseBodyBytes: 10_485_760,
      timeoutMs: 30_000,
      maxRedirects: 5,
      allowCrossHostRedirects: false,
      retryPolicy: {
        maxRetries: 0,
        retryableStatusCodes: [],
        backoffBaseMs: 100,
        backoffMaxMs: 1000,
        retryOnlyIdempotent: true,
      },
    } as unknown as ResolvedCall['egressPolicy'],
    apiId: 'example',
    bindingId: 'example-default',
    ...overrides,
  };
}

describe('attachTenantHostGuard', () => {
  it('attaches no guard in open mode', async () => {
    const s = stores({ mode: 'open', allowlist: [] });
    const out = await attachTenantHostGuard(s, {}, ctx(SPACE), resolved());
    expect(out.tenantHostGuard).toBeUndefined();
  });

  it('attaches allowlist patterns of kind api plus the artifact catalog grants', async () => {
    const s = stores({
      mode: 'allowlist',
      allowlist: [
        { kind: 'api', hostPattern: '*.allowed.example' },
        { kind: 'mcp', hostPattern: 'mcp-only.example' },
      ],
    });
    const grants = new Map<string, string[]>();
    grants.set(catalogGrantKey('api_binding', 'example-default'), ['binding-grant.example']);
    grants.set(catalogGrantKey('api_definition', 'example'), ['definition-grant.example']);
    grants.set(catalogGrantKey('api_definition', 'other'), ['unrelated.example']);
    s.catalogGrantStore.set(spaceScopeKey(TENANT, SPACE), grants);

    const out = await attachTenantHostGuard(s, {}, ctx(SPACE), resolved());
    expect(out.tenantHostGuard?.permittedHosts).toEqual([
      '*.allowed.example',
      'binding-grant.example',
      'definition-grant.example',
    ]);
  });

  it('falls back to allowlist-only when the job has no spaceId (unbound direct call)', async () => {
    const s = stores({
      mode: 'allowlist',
      allowlist: [{ kind: 'api', hostPattern: 'api.allowed.example' }],
    });
    const out = await attachTenantHostGuard(s, {}, ctx(), resolved());
    expect(out.tenantHostGuard?.permittedHosts).toEqual(['api.allowed.example']);
  });

  it('treats a missing db as open when no policy is cached', async () => {
    const out = await attachTenantHostGuard(stores(), {}, ctx(SPACE), resolved());
    expect(out.tenantHostGuard).toBeUndefined();
  });
});

describe('assertTenantPolicyPermits', () => {
  it('is a no-op without a guard (open mode)', () => {
    expect(() => assertTenantPolicyPermits(resolved(), 'evil.example')).not.toThrow();
  });

  it('fails closed on a host inside binding egress but outside the guard', () => {
    const call = resolved({ tenantHostGuard: { permittedHosts: ['api.example.com'] } });
    try {
      assertTenantPolicyPermits(call, 'evil.example');
      expect.unreachable('expected an egress block');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiExecutionError);
      const aflowError = (err as ApiExecutionError).aflowError;
      expect(aflowError.code).toBe('API_BINDING_EGRESS_BLOCKED');
      expect(aflowError.message).toContain('tenant integration policy');
      expect(aflowError.message).toContain('Tenant Admin → Integrations Policy');
      expect(aflowError.details).toMatchObject({
        blockedHost: 'evil.example',
        blockKind: 'tenant_policy_blocked',
        bindingId: 'example-default',
      });
    }
  });

  it('permits guard hosts including wildcards, case-insensitively', () => {
    const call = resolved({ tenantHostGuard: { permittedHosts: ['*.Example.COM'] } });
    expect(() => assertTenantPolicyPermits(call, 'API.example.com')).not.toThrow();
    expect(() => assertTenantPolicyPermits(call, 'example.org')).toThrow(ApiExecutionError);
  });
});
