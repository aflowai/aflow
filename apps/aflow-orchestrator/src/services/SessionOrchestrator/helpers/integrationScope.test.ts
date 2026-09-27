import { describe, expect, it } from 'vitest';
import { buildIntegrationScopeFilter } from './integrationScope.js';
import type { DiscoveryScope } from './agentTurn.js';

describe('buildIntegrationScopeFilter', () => {
  it('returns an empty allowlist when both sources are excluded', () => {
    const filter = buildIntegrationScopeFilter(undefined, false, false);
    expect(filter.allowed).toEqual([]);
  });

  it('returns no-results when scope is mode=none', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: { mode: 'none' },
    };
    expect(buildIntegrationScopeFilter(scope, true, true).allowed).toEqual([]);
  });

  it('honours mode=bound by passing through the requested sources', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: { mode: 'bound', sourceKinds: ['api', 'mcp'] },
    };
    expect(buildIntegrationScopeFilter(scope, true, true)).toMatchObject({
      sourceKinds: ['api', 'mcp'],
    });
    // No `allowed` array in bound mode — reader returns every ready binding.
  });

  it('intersects requested sources with scope sourceKinds in bound mode', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: { mode: 'bound', sourceKinds: ['mcp'] },
    };
    // Caller asked for API too but scope says MCP only — intersect, not union.
    expect(buildIntegrationScopeFilter(scope, true, true)).toMatchObject({
      sourceKinds: ['mcp'],
    });
  });

  it('returns no-results when requested sources do not intersect scope sourceKinds (reviewer round 3 P1)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['mcp'],
      integrations: { mode: 'bound', sourceKinds: ['mcp'] },
    };
    // Caller asked only for API but scope is MCP-only — must return nothing,
    // not "no sourceKinds filter = all kinds".
    const filter = buildIntegrationScopeFilter(scope, true, false);
    expect(filter.allowed).toEqual([]);
    expect(filter.sourceKinds).toBeUndefined();
  });

  it('mode=allowlist narrows to entries matching the effective source kinds', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      integrations: {
        mode: 'allowlist',
        sourceKinds: ['mcp'],
        allowed: [
          { sourceKind: 'mcp', integrationId: 'kaggle' },
          { sourceKind: 'api', integrationId: 'alpaca' }, // dropped — outside effective kinds
        ],
      },
    };
    const filter = buildIntegrationScopeFilter(scope, true, true);
    expect(filter.sourceKinds).toEqual(['mcp']);
    expect(filter.allowed).toEqual([{ sourceKind: 'mcp', integrationId: 'kaggle' }]);
  });

  it('legacy fallback: allowedApiIds + allowedMcpServerIds produce an allow list', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      allowedMcpServerIds: ['kaggle'],
    } as DiscoveryScope & { allowedApiIds?: string[] };
    (scope as DiscoveryScope & { allowedApiIds?: string[] }).allowedApiIds = ['alpaca'];

    const filter = buildIntegrationScopeFilter(scope, true, true);
    expect(filter.sourceKinds).toEqual(['api', 'mcp']);
    expect(filter.allowed).toEqual([
      { sourceKind: 'api', integrationId: 'alpaca' },
      { sourceKind: 'mcp', integrationId: 'kaggle' },
    ]);
  });

  it('legacy fallback honours requested source kinds', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['api', 'mcp'],
      allowedMcpServerIds: ['kaggle'],
    };
    const filter = buildIntegrationScopeFilter(scope, false, true);
    expect(filter.sourceKinds).toEqual(['mcp']);
    expect(filter.allowed).toEqual([{ sourceKind: 'mcp', integrationId: 'kaggle' }]);
  });

  it('fails closed when no scope is set (Plan 233 — absent scope is never wide open)', () => {
    const filter = buildIntegrationScopeFilter(undefined, true, true);
    expect(filter.allowed).toEqual([]);
  });

  it('fails closed for an op-level-only scope (promotable platform ops open no integration surface)', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: [],
      allowedOperationIds: ['memory.store.put'],
    };
    const filter = buildIntegrationScopeFilter(scope, true, true);
    expect(filter.allowed).toEqual([]);
  });

  it('legacy fallback intersects requested kinds with allowedStepTypes (reviewer round 4 P1)', () => {
    // Helmsman pre-Phase-3 ships allowedStepTypes without 'api'/'mcp'. Without
    // this intersection, search would surface integration tools that promote
    // would reject — discoverable-but-not-promotable.
    const scope: DiscoveryScope = {
      allowedStepTypes: ['ai', 'compute', 'memory', 'search'],
    };
    const filter = buildIntegrationScopeFilter(scope, true, true);
    expect(filter.allowed).toEqual([]);
  });

  it('legacy fallback keeps integration sources that ARE in allowedStepTypes', () => {
    const scope: DiscoveryScope = {
      allowedStepTypes: ['ai', 'mcp'],
      allowedMcpServerIds: ['kaggle'],
    };
    const filter = buildIntegrationScopeFilter(scope, true, true);
    expect(filter.sourceKinds).toEqual(['mcp']);
    expect(filter.allowed).toEqual([{ sourceKind: 'mcp', integrationId: 'kaggle' }]);
  });

  it('legacy fallback returns no-results when allowedStepTypes intersects to empty', () => {
    const scope: DiscoveryScope = { allowedStepTypes: ['ai'] };
    expect(buildIntegrationScopeFilter(scope, true, true).allowed).toEqual([]);
  });
});
