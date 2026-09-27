import { describe, it, expect } from 'vitest';
import type { CatalogConfig } from '@aflow/schemas';
import { resolveDiscoveryScope } from './agentTurn.js';
import type { ParsedMcpGrant } from './capabilityGrantsToCatalog.js';

const baseCatalog = (overrides: Partial<CatalogConfig> = {}): CatalogConfig =>
  ({
    discovery: { allowedStepTypes: ['ai', 'memory'] },
    ...overrides,
  }) as CatalogConfig;

const grant = (overrides: Partial<ParsedMcpGrant> = {}): ParsedMcpGrant => ({
  capabilityId: 'kaggle-cap',
  bindingId: 'kaggle-default',
  serverId: 'kaggle',
  tools: [],
  allTools: true,
  ...overrides,
});

describe('resolveDiscoveryScope.allowedMcpServerIds', () => {
  it('returns undefined when no discovery + no MCP surface configured', () => {
    expect(resolveDiscoveryScope({} as CatalogConfig)).toBeUndefined();
  });

  it('returns scope without MCP when only step-type discovery is configured', () => {
    const scope = resolveDiscoveryScope(baseCatalog());
    expect(scope?.allowedStepTypes).toEqual(['ai', 'memory']);
    expect(scope?.allowedMcpServerIds).toBeUndefined();
  });

  it('includes coreMcpServers in the union', () => {
    const scope = resolveDiscoveryScope(baseCatalog({ coreMcpServers: ['kaggle', 'linear'] }));
    expect(scope?.allowedMcpServerIds).toEqual(expect.arrayContaining(['kaggle', 'linear']));
    expect(scope?.allowedMcpServerIds).toHaveLength(2);
  });

  it('includes discovery.allowedMcpServerIds in the union', () => {
    const scope = resolveDiscoveryScope(
      baseCatalog({
        discovery: {
          allowedStepTypes: ['ai'],
          allowedMcpServerIds: ['notion', 'slack'],
        },
      } as CatalogConfig),
    );
    expect(scope?.allowedMcpServerIds).toEqual(expect.arrayContaining(['notion', 'slack']));
    expect(scope?.allowedMcpServerIds).toHaveLength(2);
  });

  it('includes task-grant serverIds in the union', () => {
    const scope = resolveDiscoveryScope(baseCatalog(), [grant({ serverId: 'kaggle' })]);
    expect(scope?.allowedMcpServerIds).toEqual(['kaggle']);
  });

  it('dedupes serverIds across the three sources', () => {
    const scope = resolveDiscoveryScope(
      baseCatalog({
        coreMcpServers: ['kaggle', 'linear'],
        discovery: {
          allowedStepTypes: ['ai'],
          allowedMcpServerIds: ['linear', 'notion'],
        },
      } as CatalogConfig),
      [grant({ serverId: 'notion' }), grant({ serverId: 'slack', bindingId: 'slack-default' })],
    );
    expect(scope?.allowedMcpServerIds).toEqual(
      expect.arrayContaining(['kaggle', 'linear', 'notion', 'slack']),
    );
    expect(scope?.allowedMcpServerIds).toHaveLength(4);
  });

  it('returns a scope with empty step types when ONLY MCP is configured', () => {
    // An agent that only has MCP access (no `discovery.allowedStepTypes`)
    // still needs a scope so mcp.tool.discover passes the access check.
    const scope = resolveDiscoveryScope({
      coreMcpServers: ['kaggle'],
    } as CatalogConfig);
    expect(scope).toBeDefined();
    expect(scope?.allowedStepTypes).toEqual([]);
    expect(scope?.allowedMcpServerIds).toEqual(['kaggle']);
  });

  it('still returns undefined when ALL sources are empty', () => {
    expect(resolveDiscoveryScope({} as CatalogConfig, [])).toBeUndefined();
  });
});

describe('resolveDiscoveryScope.mcpServers (binding-aware entries)', () => {
  it('emits a single `{ serverId }` entry per coreMcpServers serverId (no bindingId)', () => {
    const scope = resolveDiscoveryScope(baseCatalog({ coreMcpServers: ['kaggle'] }));
    expect(scope?.mcpServers).toEqual([{ serverId: 'kaggle' }]);
  });

  it('emits binding-aware entries from MCP grants — preserves bindingId', () => {
    const scope = resolveDiscoveryScope(baseCatalog(), [
      grant({
        serverId: 'kaggle',
        bindingId: 'kaggle-readonly',
        tools: [{ toolName: 'search_datasets' }, { toolName: 'get_dataset' }],
        allTools: false,
      }),
    ]);
    expect(scope?.mcpServers).toEqual([
      {
        serverId: 'kaggle',
        bindingId: 'kaggle-readonly',
        toolNames: ['search_datasets', 'get_dataset'],
      },
    ]);
  });

  it('does NOT emit toolNames when allTools is true', () => {
    const scope = resolveDiscoveryScope(baseCatalog(), [
      grant({ serverId: 'kaggle', bindingId: 'kaggle-default', allTools: true, tools: [] }),
    ]);
    expect(scope?.mcpServers).toEqual([{ serverId: 'kaggle', bindingId: 'kaggle-default' }]);
    expect(scope?.mcpServers?.[0]?.toolNames).toBeUndefined();
  });

  it('dedupes by (serverId, bindingId) — same serverId with different bindings produces 2 entries', () => {
    const scope = resolveDiscoveryScope(baseCatalog(), [
      grant({ serverId: 'kaggle', bindingId: 'kaggle-readonly' }),
      grant({ serverId: 'kaggle', bindingId: 'kaggle-admin' }),
    ]);
    expect(scope?.mcpServers).toHaveLength(2);
    expect(scope?.mcpServers?.map((e) => e.bindingId).sort()).toEqual([
      'kaggle-admin',
      'kaggle-readonly',
    ]);
    // The flat back-compat list dedupes to one
    expect(scope?.allowedMcpServerIds).toEqual(['kaggle']);
  });

  it('coreMcpServers entry (no bindingId) coexists with a grant entry (with bindingId)', () => {
    const scope = resolveDiscoveryScope(baseCatalog({ coreMcpServers: ['kaggle'] }), [
      grant({
        serverId: 'kaggle',
        bindingId: 'kaggle-readonly',
        tools: [{ toolName: 'search_datasets' }],
        allTools: false,
      }),
    ]);
    // Two entries: { serverId } and { serverId, bindingId, toolNames }
    expect(scope?.mcpServers).toHaveLength(2);
    expect(scope?.mcpServers).toEqual(
      expect.arrayContaining([
        { serverId: 'kaggle' },
        {
          serverId: 'kaggle',
          bindingId: 'kaggle-readonly',
          toolNames: ['search_datasets'],
        },
      ]),
    );
  });
});

describe('resolveDiscoveryScope: integration-only scopes (Plan 155 reviewer round 4 P1)', () => {
  it('returns a scope when only discovery.integrations is configured', () => {
    // No allowedStepTypes, no MCP entries — just the unified integration
    // scope. Without the fix, the function returned undefined and downstream
    // callers treated the agent as unscoped → wide-open integration access.
    const catalog = {
      discovery: {
        integrations: {
          mode: 'allowlist' as const,
          allowed: [
            { sourceKind: 'mcp' as const, integrationId: 'kaggle', bindingId: 'kaggle-default' },
          ],
        },
      },
    } as CatalogConfig;
    const scope = resolveDiscoveryScope(catalog);
    expect(scope).toBeDefined();
    expect(scope?.integrations).toEqual({
      mode: 'allowlist',
      allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' }],
    });
    // No legacy fields populated.
    expect(scope?.allowedStepTypes).toEqual([]);
    expect(scope?.allowedMcpServerIds).toBeUndefined();
  });

  it('still returns undefined when nothing at all is configured', () => {
    expect(resolveDiscoveryScope({} as CatalogConfig)).toBeUndefined();
  });

  it('returns a scope when discovery.integrations: { mode: "none" } is the only field', () => {
    // mode=none is an explicit "no integration discovery" — must surface as
    // a real scope so the integration check in catalog.tool.promote enforces it.
    const catalog = {
      discovery: { integrations: { mode: 'none' as const } },
    } as CatalogConfig;
    const scope = resolveDiscoveryScope(catalog);
    expect(scope?.integrations?.mode).toBe('none');
  });
});
