import { describe, it, expect } from 'vitest';
import type { ApiBinding, ApiCallInput, ApiDefinition } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { matchBindingByHost, resolveBinding, resolveCall } from './resolution.js';
import { definitionStoreKey, type ApiHandlerStores } from './types.js';

function binding(
  overrides: Partial<ApiBinding> & { bindingId: string; spaceId?: string },
): ApiBinding {
  return {
    bindingId: overrides.bindingId,
    apiId: overrides.apiId ?? 'alpaca-account-read',
    name: overrides.name ?? 'Default',
    scope: overrides.scope ?? {
      tenantId: 'tenant-1',
      ...(overrides.spaceId !== undefined ? { spaceId: overrides.spaceId } : {}),
    },
    auth: overrides.auth ?? { type: 'none' },
    egressPolicy: overrides.egressPolicy ?? {
      allowedHosts: ['api.example.com'],
      allowedMethods: ['GET'],
    },
    enabled: overrides.enabled ?? true,
  } as ApiBinding;
}

function ctx(spaceId: string): ExecutorContext {
  return {
    job: { tenantId: 'tenant-1', spaceId },
  } as unknown as ExecutorContext;
}

describe('Plan 175 — definitionStoreKey', () => {
  it('builds a stable composite key from {tenantId, spaceId, apiId}', () => {
    expect(definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-a', apiId: 'alpaca' })).toBe(
      'tenant-1|space-a|alpaca',
    );
    expect(definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-b', apiId: 'alpaca' })).toBe(
      'tenant-1|space-b|alpaca',
    );
  });

  it('keys are distinct across spaces for the same apiId', () => {
    const a = definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-a', apiId: 'alpaca' });
    const b = definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-b', apiId: 'alpaca' });
    expect(a).not.toBe(b);
  });

  it('keys are distinct across tenants for the same (apiId, spaceId)', () => {
    const a = definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-a', apiId: 'alpaca' });
    const b = definitionStoreKey({ tenantId: 'tenant-2', spaceId: 'space-a', apiId: 'alpaca' });
    expect(a).not.toBe(b);
  });
});

describe('Plan 150 Phase 0 — resolveBinding with bindingIdHint across spaces', () => {
  it('picks the binding row whose scope matches the calling job spaceId', () => {
    // Both rows share bindingId 'alpaca-account-read-default' (legal post-Path A
    // because the storage PK is composite). Their scope_json carries the owning
    // space; the resolver must pick by job spaceId, not by .find() order.
    const store = [
      binding({ bindingId: 'alpaca-account-read-default', spaceId: 'space-a' }),
      binding({ bindingId: 'alpaca-account-read-default', spaceId: 'space-b' }),
    ];

    const fromA = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('space-a'),
      'alpaca-account-read-default',
    );
    expect(fromA?.scope.spaceId).toBe('space-a');

    const fromB = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('space-b'),
      'alpaca-account-read-default',
    );
    expect(fromB?.scope.spaceId).toBe('space-b');
  });

  it('returns undefined when no candidate matches the job space', () => {
    const store = [binding({ bindingId: 'alpaca-account-read-default', spaceId: 'space-a' })];

    const fromC = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('space-c'),
      'alpaca-account-read-default',
    );
    expect(fromC).toBeUndefined();
  });

  it('still resolves tenant-wide bindings (no spaceId on scope) when hint matches', () => {
    // Legacy / migrated tenant-wide binding — its scope_json carries no
    // spaceId. The post-migration backfill assigned a sentinel space_id row
    // for storage, but the parsed scope still has no spaceId, so the
    // resolver's "tenant-wide" branch fires.
    const store = [
      binding({
        bindingId: 'tenant-wide-default',
        scope: { tenantId: 'tenant-1' },
      }),
    ];

    const result = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('any-space'),
      'tenant-wide-default',
    );
    expect(result?.bindingId).toBe('tenant-wide-default');
  });

  it('prefers a space-specific row over a legacy tenant-wide row sharing the bindingId', () => {
    const legacy = binding({
      bindingId: 'shared-default',
      scope: { tenantId: 'tenant-1' }, // no spaceId — tenant-wide
    });
    const spaceB = binding({
      bindingId: 'shared-default',
      spaceId: 'space-B',
    });
    // Legacy first in the array — the previous .find()-style short-circuit
    // would have returned it; the scored selection picks the higher-ranked
    // space-B match regardless of array order.
    const store = [legacy, spaceB];

    const fromB = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('space-B'),
      'shared-default',
    );
    expect(fromB?.scope.spaceId).toBe('space-B');

    // Reversed order — same result.
    const reversed = resolveBinding(
      [spaceB, legacy],
      'tenant-1',
      'alpaca-account-read',
      ctx('space-B'),
      'shared-default',
    );
    expect(reversed?.scope.spaceId).toBe('space-B');
  });

  it('falls back to the tenant-wide row when no space-specific row exists for the calling space', () => {
    // The flip side: when there is NO space-B-specific row, the legacy
    // tenant-wide row should still win (better than nothing).
    const legacy = binding({
      bindingId: 'shared-default',
      scope: { tenantId: 'tenant-1' },
    });
    const spaceA = binding({ bindingId: 'shared-default', spaceId: 'space-A' });
    const store = [legacy, spaceA];

    const fromB = resolveBinding(
      store,
      'tenant-1',
      'alpaca-account-read',
      ctx('space-B'),
      'shared-default',
    );
    // Legacy tenant-wide wins (space-A's row doesn't match space-B).
    expect(fromB?.scope.spaceId).toBeUndefined();
  });
});

describe('Plan 150 Phase 0 — resolveBinding heuristic across spaces', () => {
  it('without bindingIdHint, scope scoring picks the space-A binding when called from space-A', () => {
    // Same apiId, two bindings differing only in scope.spaceId. The existing
    // heuristic (line 70: score=2 for spaceId match) handles this correctly
    // but only if the candidate set includes both rows. After Path A both
    // rows live in bindingStore[] (their composite PKs differ), so the
    // heuristic sees the full set.
    const store = [
      binding({ bindingId: 'binding-a', apiId: 'alpaca', spaceId: 'space-a' }),
      binding({ bindingId: 'binding-b', apiId: 'alpaca', spaceId: 'space-b' }),
    ];

    const fromA = resolveBinding(store, 'tenant-1', 'alpaca', ctx('space-a'));
    expect(fromA?.bindingId).toBe('binding-a');

    const fromB = resolveBinding(store, 'tenant-1', 'alpaca', ctx('space-b'));
    expect(fromB?.bindingId).toBe('binding-b');
  });
});

// ---------------------------------------------------------------------------
// Host-binding matching
// ---------------------------------------------------------------------------

describe('matchBindingByHost — direct-URL fallback by allowedHosts', () => {
  const baseScope = { tenantId: 'tenant-1', spaceId: 'space-a' };

  it('returns the unique binding when exactly one allowedHosts entry matches', () => {
    const store = [
      binding({
        bindingId: 'kaggle-data-fetch-default',
        apiId: 'kaggle-data-fetch',
        spaceId: 'space-a',
        egressPolicy: {
          allowedHosts: ['www.kaggle.com', 'www.googleapis.com', '*.storage.googleapis.com'],
          allowedMethods: ['GET', 'PUT'],
        },
      }),
      binding({
        bindingId: 'alpaca-default',
        apiId: 'alpaca',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['api.alpaca.markets'], allowedMethods: ['GET'] },
      }),
    ];
    const result = matchBindingByHost(store, 'www.googleapis.com', baseScope);
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.binding.bindingId).toBe('kaggle-data-fetch-default');
    expect(result.binding.egressPolicy.allowedMethods).toContain('PUT');
  });

  it('matches via *. wildcard subdomain patterns', () => {
    const store = [
      binding({
        bindingId: 'gcs-default',
        apiId: 'gcs',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['*.storage.googleapis.com'], allowedMethods: ['PUT'] },
      }),
    ];
    const result = matchBindingByHost(store, 'my-bucket.storage.googleapis.com', baseScope);
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.binding.bindingId).toBe('gcs-default');
  });

  it('returns "none" when no binding allows the host', () => {
    const store = [
      binding({
        bindingId: 'kaggle-default',
        apiId: 'kaggle',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['www.kaggle.com'], allowedMethods: ['GET'] },
      }),
    ];
    const result = matchBindingByHost(store, 'evil.example.com', baseScope);
    expect(result.kind).toBe('none');
  });

  it('skips bindings scoped to a different space (no leakage across spaces)', () => {
    const store = [
      binding({
        bindingId: 'gcs-default',
        apiId: 'gcs',
        spaceId: 'space-b', // different space
        egressPolicy: { allowedHosts: ['www.googleapis.com'], allowedMethods: ['PUT'] },
      }),
    ];
    const result = matchBindingByHost(store, 'www.googleapis.com', baseScope);
    expect(result.kind).toBe('none');
  });

  it('skips disabled bindings', () => {
    const store = [
      binding({
        bindingId: 'gcs-default',
        apiId: 'gcs',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['www.googleapis.com'], allowedMethods: ['PUT'] },
        enabled: false,
      }),
    ];
    const result = matchBindingByHost(store, 'www.googleapis.com', baseScope);
    expect(result.kind).toBe('none');
  });

  it('prefers space-scoped binding over tenant-wide when both match', () => {
    const store = [
      binding({
        bindingId: 'gcs-tenant-wide',
        apiId: 'gcs',
        scope: { tenantId: 'tenant-1' }, // no spaceId — tenant-wide
        egressPolicy: { allowedHosts: ['www.googleapis.com'], allowedMethods: ['PUT'] },
      }),
      binding({
        bindingId: 'gcs-space-a',
        apiId: 'gcs',
        spaceId: 'space-a', // current space
        egressPolicy: { allowedHosts: ['www.googleapis.com'], allowedMethods: ['PUT'] },
      }),
    ];
    const result = matchBindingByHost(store, 'www.googleapis.com', baseScope);
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.binding.bindingId).toBe('gcs-space-a');
  });

  it('returns "ambiguous" when two bindings tie at the same scope rank', () => {
    // Two distinct API bindings, both in the caller's space, both matching
    const store = [
      binding({
        bindingId: 'gcs-default',
        apiId: 'gcs-storage',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['storage.googleapis.com'], allowedMethods: ['PUT'] },
      }),
      binding({
        bindingId: 'gcp-default',
        apiId: 'gcp-blob',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['storage.googleapis.com'], allowedMethods: ['GET'] },
      }),
    ];
    const result = matchBindingByHost(store, 'storage.googleapis.com', baseScope);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((b) => b.apiId).sort()).toEqual(['gcp-blob', 'gcs-storage']);
  });

  it('is not ambiguous when one space-scoped binding outranks a tenant-wide match', () => {
    const store = [
      binding({
        bindingId: 'gcs-tenant',
        apiId: 'gcs-storage',
        scope: { tenantId: 'tenant-1' },
        egressPolicy: { allowedHosts: ['storage.googleapis.com'], allowedMethods: ['GET'] },
      }),
      binding({
        bindingId: 'gcs-space-a',
        apiId: 'gcs-blob',
        spaceId: 'space-a',
        egressPolicy: { allowedHosts: ['storage.googleapis.com'], allowedMethods: ['PUT'] },
      }),
    ];
    const result = matchBindingByHost(store, 'storage.googleapis.com', baseScope);
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.binding.bindingId).toBe('gcs-space-a');
  });

  it('PUT to www.googleapis.com routes to kaggle-data-fetch binding', () => {
    // The kaggle-data-fetch binding has
    // www.googleapis.com in allowedHosts and PUT in allowedMethods. A
    // Runner that drops apiId/bindingId on retry would otherwise fall
    // through to DEFAULT_EGRESS_POLICY (GET/POST only); with
    // host-binding matching the runtime resolves the same binding
    // the explicit-call path would have used.
    const store = [
      binding({
        bindingId: 'kaggle-data-fetch-default',
        apiId: 'kaggle-data-fetch',
        spaceId: 'space-a',
        egressPolicy: {
          allowedHosts: [
            'www.kaggle.com',
            'storage.googleapis.com',
            '*.storage.googleapis.com',
            'storage.cloud.google.com',
            'www.googleapis.com',
            'uploads.googleapis.com',
          ],
          allowedMethods: ['GET', 'PUT'],
        },
      }),
    ];
    const result = matchBindingByHost(store, 'www.googleapis.com', baseScope);
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.binding.apiId).toBe('kaggle-data-fetch');
    expect(result.binding.egressPolicy.allowedMethods).toContain('PUT');
  });
});

function stores(): ApiHandlerStores {
  return {
    definitionStore: new Map(),
    invalidDefinitions: new Map(),
    bindingStore: new Map(),
    credentialStore: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: {
      load: () => Promise.resolve({ mode: 'open', allowlist: [] }),
      peek: () => undefined,
    },
    catalogGrantStore: new Map(),
    spaceWritePolicyStore: new Map(),
    simulationStore: new Map(),
    simulationLoadPromises: new Map(),
    simulationSnapshotStore: new Map(),
  } as unknown as ApiHandlerStores;
}

describe('invalid stored definition surfaces validation issues, not "not found"', () => {
  it('names the validation issues when the row exists but failed the model parse', async () => {
    const s = stores();
    s.invalidDefinitions.set(
      definitionStoreKey({
        tenantId: 'tenant-1',
        spaceId: 'space-a',
        apiId: 'alpaca-paper-orders-write',
      }),
      'endpoints.2.name: Required; endpoints.2.pathTemplate: Required',
    );
    await expect(
      resolveCall(s, {}, ctx('space-a'), {
        apiId: 'alpaca-paper-orders-write',
        endpointId: 'delete_orders_order_id',
        method: 'GET',
      } as ApiCallInput),
    ).rejects.toThrow(/exists in space space-a but fails validation.*pathTemplate: Required/);
  });

  it('stays "not found" when no row exists at all', async () => {
    await expect(
      resolveCall(stores(), {}, ctx('space-a'), {
        apiId: 'missing-api',
        endpointId: 'nope',
        method: 'GET',
      } as ApiCallInput),
    ).rejects.toThrow(/"missing-api" not found in space space-a/);
  });
});

describe('a simulated binding never answers a direct-URL call', () => {
  function simulatedStores(): ApiHandlerStores {
    const s = stores();
    s.bindingStore.set('tenant-1|space-a', [
      {
        ...binding({ bindingId: 'b_sim', apiId: 'payments', spaceId: 'space-a' }),
        fulfillment: { mode: 'simulated', simulationId: 'sim_payments' },
      } as ApiBinding,
    ]);
    return s;
  }

  it('refuses the explicit apiId + bindingId + url route', async () => {
    await expect(
      resolveCall(simulatedStores(), {}, ctx('space-a'), {
        apiId: 'payments',
        bindingId: 'b_sim',
        url: 'https://api.example.com/v1/refunds',
        method: 'POST',
      } as ApiCallInput),
    ).rejects.toThrow(/fulfilled by simulation "sim_payments"/);
  });

  it('refuses the host-matched route rather than reaching the allowed host', async () => {
    await expect(
      resolveCall(simulatedStores(), {}, ctx('space-a'), {
        url: 'https://api.example.com/v1/refunds',
        method: 'GET',
      } as ApiCallInput),
    ).rejects.toThrow(/fulfilled by simulation "sim_payments"/);
  });
});

describe('a simulated call builds the request shape the promoted binding will send', () => {
  const endpoint = {
    endpointId: 'get_refund',
    name: 'Get refund',
    method: 'GET' as const,
    pathTemplate: '/v1/customers/{customerId}/refunds/{refundId}',
    params: [
      { name: 'customerId', location: 'path' as const, required: true },
      { name: 'refundId', location: 'path' as const, required: true },
      { name: 'expand', location: 'query' as const, required: false },
    ],
  };

  function simulatedStores(definition: Partial<ApiDefinition>): ApiHandlerStores {
    const s = stores();
    s.definitionStore.set(
      definitionStoreKey({ tenantId: 'tenant-1', spaceId: 'space-a', apiId: 'payments' }),
      {
        apiId: 'payments',
        name: 'Payments',
        version: '1',
        callMode: 'endpoint',
        endpoints: [endpoint],
        ...definition,
      } as ApiDefinition,
    );
    s.bindingStore.set('tenant-1|space-a', [
      {
        ...binding({ bindingId: 'b_sim', apiId: 'payments', spaceId: 'space-a' }),
        fulfillment: { mode: 'simulated', simulationId: 'sim_payments' },
        variableValues: definition.baseUrlTemplate ? { region: 'evil.com/' } : {},
      } as ApiBinding,
    ]);
    return s;
  }

  const call = {
    apiId: 'payments',
    endpointId: 'get_refund',
    method: 'GET',
    params: { customerId: 'cus_1', refundId: 're_9', expand: 'order' },
  } as ApiCallInput;

  it('substitutes only the unavailable origin, keeping path and query intact', async () => {
    // The origin is the one thing a simulation may invent. Dropping the query
    // or the path parameters would let a call pass simulation and fail the day
    // the binding goes live.
    const resolved = await resolveCall(simulatedStores({}), {}, ctx('space-a'), call);

    expect(resolved.url).toBe(
      'https://simulated.invalid/payments/v1/customers/cus_1/refunds/re_9?expand=order',
    );
  });

  it('keeps a resolvable origin rather than substituting one', async () => {
    const resolved = await resolveCall(
      simulatedStores({ baseUrl: 'https://api.example.com/' }),
      {},
      ctx('space-a'),
      call,
    );

    expect(resolved.url).toBe(
      'https://api.example.com/v1/customers/cus_1/refunds/re_9?expand=order',
    );
  });

  it('fails the call when a required path parameter is missing', async () => {
    await expect(
      resolveCall(simulatedStores({}), {}, ctx('space-a'), {
        ...call,
        params: { customerId: 'cus_1' },
      } as ApiCallInput),
    ).rejects.toThrow(/Required path parameter "refundId" missing/);
  });

  it('fails the call when a template variable carries URL structure', async () => {
    // An origin nobody supplied is the simulated case; an origin somebody
    // supplied that the host guard rejects is an operator error that will fail
    // identically once the binding is live.
    await expect(
      resolveCall(
        simulatedStores({
          baseUrlTemplate: 'https://{region}.example.com',
          variables: [{ name: 'region', required: true }],
        }),
        {},
        ctx('space-a'),
        call,
      ),
    ).rejects.toThrow(/has an invalid value/);
  });
});
