import { describe, it, expect } from 'vitest';
import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';
import { resolveDefinitionAndBinding, checkToolCallACL } from './resolution.js';
import { definitionStoreKey, getMcpSpaceStores, type McpHandlerStores } from './types.js';

const TENANT = 'tenant-1';

function definition(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    serverId: 'kaggle',
    name: 'Kaggle',
    serverUrl: 'https://www.kaggle.com/mcp',
    transport: 'streamable_http',
    tags: [],
    source: 'platform',
    ...overrides,
  } as McpServerDefinition;
}

function binding(
  overrides: Partial<McpServerBinding> & { bindingId?: string } = {},
): McpServerBinding {
  return {
    bindingId: 'kaggle-default',
    serverId: 'kaggle',
    name: 'Default',
    scope: { tenantId: 'tenant-1' },
    auth: { type: 'bearer', credentialKey: 'KAGGLE_MCP_TOKEN' },
    connectionPolicy: {
      timeoutMs: 30_000,
      maxResponseBytes: 10_485_760,
      maxSamplingTokens: 4_096,
      maxSamplingDepth: 1,
      elicitationLeaseMs: 900_000,
    },
    subscribeListChanged: true,
    samplingPolicy: 'off',
    enabled: true,
    pinnedOrigin: 'https://www.kaggle.com',
    ...overrides,
  } as McpServerBinding;
}

function emptyStores(): McpHandlerStores {
  return {
    bySpace: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: {
      load: () => Promise.resolve({ mode: 'open', allowlist: [] }),
      peek: () => undefined,
    },
  };
}

function storesWith(
  defs: McpServerDefinition[],
  bindings: McpServerBinding[],
  spaceId = 'space-a',
): McpHandlerStores {
  const stores = emptyStores();
  const slice = getMcpSpaceStores(stores, TENANT, spaceId);
  for (const d of defs) {
    slice.definitionStore.set(
      definitionStoreKey({ tenantId: TENANT, spaceId, serverId: d.serverId }),
      d,
    );
  }
  slice.bindingStore = bindings;
  return stores;
}

describe('resolveDefinitionAndBinding', () => {
  it('returns no_space_id when the job has no spaceId', () => {
    const stores = storesWith([definition()], [binding()]);
    const result = resolveDefinitionAndBinding(stores, { tenantId: 'tenant-1' }, 'kaggle');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_space_id');
  });

  it('returns definition_not_found when the (serverId, spaceId) row is missing', () => {
    const stores = storesWith([], [binding()]);
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('definition_not_found');
      expect(result.message).toContain('definition_not_found');
    }
  });

  it('returns no_binding when no binding matches serverId + tenantId', () => {
    const stores = storesWith([definition()], []);
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_binding');
  });

  it('returns binding_disabled when the resolved binding has enabled: false', () => {
    const stores = storesWith([definition()], [binding({ enabled: false })]);
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('binding_disabled');
      expect(result.message).toContain('binding_disabled');
    }
  });

  it('returns origin_not_pinned for a credentialed binding without pinnedOrigin', () => {
    const stores = storesWith([definition()], [binding({ pinnedOrigin: undefined })]);
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('origin_not_pinned');
      expect(result.message).toContain('origin_not_pinned');
    }
  });

  it('allows auth.type: none bindings without pinnedOrigin', () => {
    const stores = storesWith(
      [definition()],
      [binding({ auth: { type: 'none' }, pinnedOrigin: undefined })],
    );
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(true);
  });

  it('returns origin_mismatch when definition URL origin differs from pin', () => {
    const stores = storesWith(
      [definition({ serverUrl: 'https://evil.example.com/mcp' })],
      [binding({ pinnedOrigin: 'https://www.kaggle.com' })],
    );
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('origin_mismatch');
      expect(result.message).toContain('origin_mismatch');
    }
  });

  it('returns ok with definition + binding when all checks pass', () => {
    const stores = storesWith([definition()], [binding()]);
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a' },
      'kaggle',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.serverId).toBe('kaggle');
      expect(result.binding.bindingId).toBe('kaggle-default');
    }
  });

  it('prefers flow-scoped over space-scoped over tenant-scoped bindings', () => {
    const stores = storesWith(
      [definition()],
      [
        binding({ bindingId: 'tenant-wide' }),
        binding({ bindingId: 'space-bound', scope: { tenantId: 'tenant-1', spaceId: 'space-a' } }),
        binding({
          bindingId: 'flow-bound',
          scope: { tenantId: 'tenant-1', spaceId: 'space-a', flowId: 'flow-x' },
        }),
      ],
    );
    const result = resolveDefinitionAndBinding(
      stores,
      { tenantId: 'tenant-1', spaceId: 'space-a', flowId: 'flow-x' },
      'kaggle',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.binding.bindingId).toBe('flow-bound');
  });
});

describe('checkToolCallACL (executor call-time gate)', () => {
  it('blocks when no filter is set (opt-in semantics)', () => {
    const result = checkToolCallACL(definition(), binding(), 'search_datasets');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('toolFilter');
  });

  it('passes when the tool is in definition.toolFilter.include', () => {
    expect(
      checkToolCallACL(
        definition({ toolFilter: { include: ['search_datasets'] } }),
        binding(),
        'search_datasets',
      ).ok,
    ).toBe(true);
  });

  it('rejects tools blocked by definition.toolFilter.exclude', () => {
    const result = checkToolCallACL(
      definition({ toolFilter: { include: ['delete_dataset'], exclude: ['delete_dataset'] } }),
      binding(),
      'delete_dataset',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('toolFilter');
  });

  it('rejects tools not in definition.toolFilter.include', () => {
    const result = checkToolCallACL(
      definition({ toolFilter: { include: ['search_datasets'] } }),
      binding(),
      'delete_dataset',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('toolFilter');
  });

  it('definition.exclude wins over include', () => {
    const result = checkToolCallACL(
      definition({
        toolFilter: { include: ['search_datasets', 'delete_dataset'], exclude: ['delete_dataset'] },
      }),
      binding(),
      'delete_dataset',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('toolFilter');
  });
});
