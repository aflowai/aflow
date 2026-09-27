/**
 * Tests for `buildAvailableTools` — specifically the MAX_VIRTUAL_TOOLS cap.
 *
 * Regression coverage for the 2026-05-29 silent-drop bug:
 *   The LRU cap counted `source: 'core'` tools alongside discovered ones,
 *   so Helmsman's ~34 pinned coreOperations exhausted the cap (=20) before
 *   the loop touched the first promoted MCP tool. Every promoted tool was
 *   dropped on the floor without warning; `catalog.tool.promote` returned
 *   `count: 3` and the agent thought it had them; the next agent turn's
 *   `availableTools` list contained zero `mcp:*` entries.
 *
 * The fix narrowed the count to `source: 'discovered'` only. These tests
 * pin that contract so the cap can't quietly re-include core tools again.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, AgentToolSpec, CatalogConfig, RunAccessGrant } from '@aflow/schemas';
import {
  MEMORY_READ_OPERATION_ID,
  RUN_OUTPUT_READ_OPERATION_ID,
  RISK_MODIFIERS,
  buildVirtualToolSpec,
  getOperation,
  bundlesForSurface,
  capabilityGroupsForBundles,
  applyBundlePlacements,
} from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '@aflow/platform-artifacts';
import { effectiveOperationIdForSpec } from './toolAccess.js';
import {
  buildAvailableTools,
  withGuaranteedReadOps,
  resolveDiscoveryScope,
  buildPromotableAwareness,
  resolveHelmsmanDiscoveryOverride,
  MAX_VIRTUAL_TOOLS,
  type VirtualToolEntry,
} from './agentTurn.js';
import {
  MAX_TOTAL_TOOLS,
  admitConnectionsWithinCap,
  applyCapabilitySettings,
  resolveBundlePlacements,
  resolveConnectionAllowlist,
  withPromotedToolsRevoked,
} from './capabilityShedding.js';

function makeAgent(): AgentDefinition {
  return {
    schemaVersion: 1,
    flowId: 'test-helmsman',
    version: '1',
    metadata: { name: 'Test Helmsman', description: '' },
    systemRole: null,
    stateVariables: [],
    steps: [
      {
        stepId: 'agent',
        operation: 'ai.agent.turn',
        stepType: 'ai',
        config: {},
        onSuccess: { next: [] },
        onFailure: { next: [] },
        tags: [],
      },
    ],
    startStepId: 'agent',
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'published',
  } as unknown as AgentDefinition;
}

function makeMcpSpec(bindingId: string, toolName: string): AgentToolSpec {
  return buildVirtualToolSpec({
    operationId: `mcp:${bindingId}/${toolName}`,
    stepType: 'mcp',
    name: toolName,
    description: `MCP tool ${toolName}`,
    inputSchema: { type: 'object' },
    source: 'mcp',
    lowering: 'mcp_call',
    callName: `mcp_${bindingId}.${toolName}`,
    mcpMeta: { serverId: bindingId, toolName, bindingId },
  });
}

describe('buildAvailableTools — MAX_VIRTUAL_TOOLS cap', () => {
  it('admits promoted tools when coreOperations alone exceed the cap (regression for 2026-05-29 Helmsman bug)', () => {
    // Helmsman ships ~34 pinned coreOperations; cap is 20. The original
    // (buggy) cap counted core ops, so this scenario would silently drop
    // every promoted tool. The fix scopes the cap to `source: 'discovered'`.
    const coreOperations = Array.from(
      { length: MAX_VIRTUAL_TOOLS + 5 },
      (_, i) => `memory.store.${i === 0 ? 'put' : `op${String(i)}`}`,
    );
    // Use a real op as the first entry so getOperation resolves; the rest
    // can be no-ops (they get filtered by getOperation returning undefined).
    const virtualToolsState: Record<string, VirtualToolEntry> = {
      'mcp:kaggle-default/list_competition_data_files': { discoveredAtTurn: 1 },
      'mcp:kaggle-default/download_competition_data_file': { discoveredAtTurn: 1 },
      'mcp:kaggle-default/get_dataset_files_summary': { discoveredAtTurn: 1 },
    };
    const discoveredMcpToolSpecs: AgentToolSpec[] = [
      makeMcpSpec('kaggle-default', 'list_competition_data_files'),
      makeMcpSpec('kaggle-default', 'download_competition_data_file'),
      makeMcpSpec('kaggle-default', 'get_dataset_files_summary'),
    ];

    const tools = buildAvailableTools(
      makeAgent(),
      'agent',
      { coreOperations },
      virtualToolsState,
      undefined,
      undefined,
      undefined,
      undefined,
      discoveredMcpToolSpecs,
    );

    // All three promoted MCP tools must reach the agent's surface — that
    // was the silent-drop bug. Their toolIds use the `mcp:` prefix.
    const mcpToolIds = tools.filter((t) => t.toolId.startsWith('mcp:')).map((t) => t.toolId);
    expect(mcpToolIds).toEqual(
      expect.arrayContaining([
        'mcp:kaggle-default/list_competition_data_files',
        'mcp:kaggle-default/download_competition_data_file',
        'mcp:kaggle-default/get_dataset_files_summary',
      ]),
    );
  });

  it('caps at MAX_VIRTUAL_TOOLS discovered entries and keeps the most-recently-used', () => {
    // The cap still has to apply — just to discovered tools only, with
    // LRU sort. Stuff MAX_VIRTUAL_TOOLS + 3 mcp entries in, oldest first;
    // expect the 3 oldest (by lastUsedAtTurn / discoveredAtTurn) to drop.
    const virtualToolsState: Record<string, VirtualToolEntry> = {};
    const specs: AgentToolSpec[] = [];
    for (let i = 0; i < MAX_VIRTUAL_TOOLS + 3; i++) {
      const toolId = `mcp:srv/tool_${String(i)}`;
      virtualToolsState[toolId] = { discoveredAtTurn: i };
      specs.push(makeMcpSpec('srv', `tool_${String(i)}`));
    }

    const tools = buildAvailableTools(
      makeAgent(),
      'agent',
      undefined,
      virtualToolsState,
      undefined,
      undefined,
      undefined,
      undefined,
      specs,
    );

    const mcpToolIds = tools.filter((t) => t.toolId.startsWith('mcp:')).map((t) => t.toolId);
    expect(mcpToolIds).toHaveLength(MAX_VIRTUAL_TOOLS);
    // LRU keeps the most-recent (highest discoveredAtTurn). tool_0..tool_2
    // are the oldest and should be the ones evicted.
    expect(mcpToolIds).not.toContain('mcp:srv/tool_0');
    expect(mcpToolIds).not.toContain('mcp:srv/tool_1');
    expect(mcpToolIds).not.toContain('mcp:srv/tool_2');
    // The newest should survive.
    expect(mcpToolIds).toContain(`mcp:srv/tool_${String(MAX_VIRTUAL_TOOLS + 2)}`);
  });
});

describe('buildAvailableTools — promotion provenance (Plan 259)', () => {
  it('stamps discoveredAtTurn/lastUsedAtTurn from _virtualTools onto promoted specs', () => {
    const virtualToolsState: Record<string, VirtualToolEntry> = {
      'mcp:srv/alpha': { discoveredAtTurn: 3, lastUsedAtTurn: 5 },
      'mcp:srv/beta': { discoveredAtTurn: 2 },
    };
    const specs = [makeMcpSpec('srv', 'alpha'), makeMcpSpec('srv', 'beta')];

    const tools = buildAvailableTools(
      makeAgent(),
      'agent',
      undefined,
      virtualToolsState,
      undefined,
      undefined,
      undefined,
      undefined,
      specs,
    );

    const alpha = tools.find((t) => t.toolId === 'mcp:srv/alpha');
    const beta = tools.find((t) => t.toolId === 'mcp:srv/beta');
    expect(alpha?.discoveredAtTurn).toBe(3);
    expect(alpha?.lastUsedAtTurn).toBe(5);
    expect(beta?.discoveredAtTurn).toBe(2);
    expect(beta?.lastUsedAtTurn).toBeUndefined();
  });
});

describe('withGuaranteedReadOps — Plan 196 §4.9 guaranteed re-read surface', () => {
  it('an agent config without memory ops gets the run-output read floor via the merge', () => {
    const config = withGuaranteedReadOps({ coreOperations: ['ai.text.generate'] });
    expect(config.coreOperations).toContain(RUN_OUTPUT_READ_OPERATION_ID);
    expect(config.coreOperations).not.toContain(MEMORY_READ_OPERATION_ID);

    const tools = buildAvailableTools(makeAgent(), 'agent', config);
    const readTool = tools.find((t) => t.operationId === RUN_OUTPUT_READ_OPERATION_ID);
    expect(readTool).toBeDefined();
    expect(readTool!.kind).toBe('virtual');
  });

  it('an agent with no catalog config at all gets the run-output read floor', () => {
    const config = withGuaranteedReadOps(undefined);
    expect(config.coreOperations).toEqual([RUN_OUTPUT_READ_OPERATION_ID]);
  });

  it('an agent holding the full memory read keeps just that — no redundant floor sibling', () => {
    const config = withGuaranteedReadOps({ coreOperations: [MEMORY_READ_OPERATION_ID] });
    expect(config.coreOperations).toEqual([MEMORY_READ_OPERATION_ID]);
  });

  it('does not duplicate an already-configured run-output read op', () => {
    const config = withGuaranteedReadOps({ coreOperations: [RUN_OUTPUT_READ_OPERATION_ID] });
    expect(config.coreOperations).toEqual([RUN_OUTPUT_READ_OPERATION_ID]);
  });
});

describe('Runner effective tool surface — declared = ceiling (Plan 233)', () => {
  // Locks the EFFECTIVE surface, not the static Runner base. With the ambient
  // base removed (coreOperations: []), a Runner task's coreOperations is
  // exactly its declared ops (runner_tools) merged with the read floor. This
  // asserts that a task declaring only `memory.store.get` never sees the old
  // ambient six (compute / memory query+put / workflow.learn / ledger.get) or
  // any catalog.tool.* discovery op on its surface.
  it('a task declaring only memory.store.get surfaces exactly that + no ambient tools', () => {
    // Mirror the orchestrator assembly: empty base + declared op + read floor.
    const declared = { coreOperations: ['memory.store.get'] };
    const effective = withGuaranteedReadOps(declared);
    const tools = buildAvailableTools(makeAgent(), 'agent', effective);
    const opIds = tools.map((t) => t.operationId);

    expect(opIds).toContain('memory.store.get');
    for (const forbidden of [
      'compute.sandbox.exec',
      'memory.store.query',
      'memory.store.put',
      'workflow.learn',
      'workflow.ledger.get',
      'catalog.tool.search',
      'catalog.tool.promote',
    ]) {
      expect(opIds).not.toContain(forbidden);
    }
  });
});

describe('resolveDiscoveryScope — promotable tier (Plan 233)', () => {
  it('a task promotable grant alone produces an op-level scope', () => {
    const scope = resolveDiscoveryScope({}, undefined, ['memory.store.put', 'search.web.search']);
    expect(scope).toBeDefined();
    expect(scope!.allowedOperationIds).toEqual(['memory.store.put', 'search.web.search']);
    expect(scope!.allowedStepTypes).toEqual([]);
  });

  it('promotable ops union with an authored op-level discovery config', () => {
    const scope = resolveDiscoveryScope(
      { discovery: { allowedOperationIds: ['memory.store.get'] } },
      undefined,
      ['memory.store.put'],
    );
    expect(scope!.allowedOperationIds).toEqual(['memory.store.get', 'memory.store.put']);
  });

  it('no discovery config and no promotable grant → no scope (discovery disabled)', () => {
    expect(resolveDiscoveryScope({}, undefined, undefined)).toBeUndefined();
    expect(resolveDiscoveryScope({}, undefined, [])).toBeUndefined();
  });

  it('an explicitly-authored EMPTY op-level list is preserved as [] — discovery off, not stepType fallthrough (Plan 233 override)', () => {
    // `capabilityDiscovery.helmsmanOperations: []` reaches here as
    // discovery.allowedOperationIds: []. It must survive as an empty list (op-level
    // authority = deny all) even alongside allowedStepTypes — NOT collapse to
    // "no op-level → use stepTypes".
    const scope = resolveDiscoveryScope(
      { discovery: { allowedOperationIds: [], allowedStepTypes: ['compute', 'ai'] } },
      undefined,
      undefined,
    );
    expect(scope).toBeDefined();
    expect(scope!.allowedOperationIds).toEqual([]);
  });

  it('resolveHelmsmanDiscoveryOverride distinguishes [] (off) from unset', () => {
    expect(
      resolveHelmsmanDiscoveryOverride({ capabilityDiscovery: { helmsmanOperations: [] } }),
    ).toEqual([]);
    expect(resolveHelmsmanDiscoveryOverride({})).toBeUndefined();
    expect(
      resolveHelmsmanDiscoveryOverride({
        capabilityDiscovery: { helmsmanOperations: ['memory.store.get'] },
      }),
    ).toEqual(['memory.store.get']);
  });

  it('a stepType-scoped agent config is unaffected by an absent promotable grant', () => {
    const scope = resolveDiscoveryScope({ discovery: { allowedStepTypes: ['ai', 'memory'] } });
    expect(scope!.allowedStepTypes).toEqual(['ai', 'memory']);
    expect(scope!.allowedOperationIds).toBeUndefined();
  });
});

describe('resolveDiscoveryScope — grant-derived scope closes agent discovery (Plan 233 P1 fix)', () => {
  it('a promotable-only scope (no authored discovery) sets allowedAgents: false', () => {
    const scope = resolveDiscoveryScope({}, undefined, ['memory.store.put']);
    expect(scope!.allowedAgents).toBe(false);
  });

  it('an MCP-grant-derived scope (no authored discovery) sets allowedAgents: false', () => {
    const scope = resolveDiscoveryScope({}, [
      { serverId: 'kaggle', bindingId: 'kaggle-default', allTools: true, tools: [] },
    ] as never);
    expect(scope!.allowedAgents).toBe(false);
  });

  it('an authored discovery config keeps its own allowedAgents semantics (undefined stays open)', () => {
    const scope = resolveDiscoveryScope({ discovery: { allowedStepTypes: ['ai'] } });
    expect(scope!.allowedAgents).toBeUndefined();
  });

  it('an authored allowedAgents: true is preserved even alongside a promotable grant', () => {
    const scope = resolveDiscoveryScope(
      { discovery: { allowedStepTypes: ['ai'], allowedAgents: true } },
      undefined,
      ['memory.store.put'],
    );
    expect(scope!.allowedAgents).toBe(true);
  });
});

describe('buildPromotableAwareness (Plan 233 — the promote affordance)', () => {
  it('lists the exact op IDs and teaches promote-then-call', () => {
    const md = buildPromotableAwareness([
      { operationId: 'memory.store.put' },
      { operationId: 'search.web.search' },
    ]);
    expect(md).toContain('memory.store.put');
    expect(md).toContain('search.web.search');
    expect(md).toMatch(/catalog\.tool\.promote/);
    expect(md).toMatch(/Promotable operations/i);
  });

  it('returns empty string for no ops', () => {
    expect(buildPromotableAwareness([])).toBe('');
  });
});

describe('resolveHelmsmanDiscoveryOverride (Plan 233 Part 3 — operator-tunable ceiling)', () => {
  it('returns undefined when no directive override is set (preset applies)', () => {
    expect(resolveHelmsmanDiscoveryOverride(undefined)).toBeUndefined();
    expect(resolveHelmsmanDiscoveryOverride({})).toBeUndefined();
    expect(resolveHelmsmanDiscoveryOverride({ capabilityDiscovery: {} })).toBeUndefined();
  });

  it('returns the operator list when set (widen/shrink)', () => {
    const ops = resolveHelmsmanDiscoveryOverride({
      capabilityDiscovery: { helmsmanOperations: ['search.web.search', 'memory.store.patch'] },
    });
    expect(ops).toEqual(['search.web.search', 'memory.store.patch']);
  });

  it('an explicit empty list is an override (discovery off), not "unset"', () => {
    expect(
      resolveHelmsmanDiscoveryOverride({ capabilityDiscovery: { helmsmanOperations: [] } }),
    ).toEqual([]);
  });

  it('filters non-string / empty entries', () => {
    const ops = resolveHelmsmanDiscoveryOverride({
      capabilityDiscovery: { helmsmanOperations: ['ok', '', 3, null] },
    });
    expect(ops).toEqual(['ok']);
  });
});

// Read off the shipped Helmsman definition rather than copied: these cases
// assert how a grant filters the REAL pinned surface, so a hand-kept list would
// quietly stop testing the agent it names.
const HELMSMAN_CORE_OPERATIONS: string[] = (() => {
  const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
  if (!helmsman) throw new Error('platform agent cybernetic-helmsman not found');
  const agentStep = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
  const ops = (agentStep?.config as { catalog?: { coreOperations?: string[] } } | undefined)
    ?.catalog?.coreOperations;
  if (!ops?.length) throw new Error('cybernetic-helmsman declares no coreOperations');
  return ops;
})();

function makeGrant(overrides: Partial<RunAccessGrant> = {}): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [],
      deniedCapabilities: [],
      allowedRiskModifiers: [...RISK_MODIFIERS],
      deniedRiskModifiers: [],
      allowPrivileged: true,
    },
    grantReason: 'start',
    resourceScopes: [],
    ...overrides,
  };
}

function makeApiSpec(): AgentToolSpec {
  return buildVirtualToolSpec({
    operationId: 'api:github/create_issue',
    stepType: 'api',
    name: 'create_issue',
    description: 'Create a GitHub issue',
    inputSchema: { type: 'object' },
    source: 'api',
    lowering: 'api_call',
    apiMeta: { apiId: 'github', endpointId: 'create_issue', bindingId: 'github-default' },
  });
}

function makeAppletSpec(): AgentToolSpec {
  return buildVirtualToolSpec({
    operationId: 'ui.applet.act',
    toolId: 'chess.move',
    callName: 'chess.move',
    stepType: 'ui',
    name: 'chess.move',
    description: 'Make a chess move',
    inputSchema: { type: 'object' },
    source: 'applet',
    appletMeta: { instanceId: 'inst-1', actionName: 'move', patchMode: 'template', baseVersion: 3 },
  });
}

function buildHelmsmanSurface(access?: Parameters<typeof buildAvailableTools>[10]) {
  return buildAvailableTools(
    makeAgent(),
    'agent',
    { coreOperations: HELMSMAN_CORE_OPERATIONS },
    undefined,
    [{ agentId: 'cybernetic-coach', name: 'Coach', description: 'The Coach' }],
    [makeApiSpec()],
    undefined,
    [makeMcpSpec('kaggle-default', 'search_competitions')],
    undefined,
    [makeAppletSpec()],
    access,
  );
}

describe('buildAvailableTools — grant-filtered materialization', () => {
  it('a full-access-shaped grant leaves the surface unchanged', () => {
    const baseline = buildHelmsmanSurface();
    const filtered = buildHelmsmanSurface({ grant: makeGrant() });
    expect(filtered).toEqual(baseline);
  });

  it('a read-only-shaped grant offers no mutating op and drops lowered write surfaces', () => {
    const readOnly = makeGrant({
      accessLevel: 'read',
      capabilities: {
        allowedCapabilities: [
          { capabilityGroupId: 'ai.agent', accessMode: 'write' },
          { capabilityGroupId: 'flow.control', accessMode: 'write' },
          { capabilityGroupId: 'memory.store', accessMode: 'read' },
          { capabilityGroupId: 'workflow.manage', accessMode: 'read' },
        ],
        deniedCapabilities: [],
        allowedRiskModifiers: [],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
    });

    const tools = buildHelmsmanSurface({ grant: readOnly });
    const toolIds = tools.map((t) => t.toolId);

    expect(toolIds).toContain('memory.store.query');
    expect(toolIds).toContain('memory.store.get');
    expect(toolIds).toContain('workflow.manage.get');

    for (const tool of tools) {
      expect(getOperation(effectiveOperationIdForSpec(tool))?.mutates).not.toBe(true);
    }
    for (const forbidden of [
      'memory.store.put',
      'workflow.run.start',
      'search.web.search',
      'api:github/create_issue',
      'mcp:kaggle-default/search_competitions',
      'chess.move',
      'cybernetic_coach',
    ]) {
      expect(toolIds).not.toContain(forbidden);
    }
  });

  it('a null grant leaves the surface unchanged', () => {
    expect(buildHelmsmanSurface({ grant: null })).toEqual(buildHelmsmanSurface());
  });
});

describe('capability bundles — per-agent connections', () => {
  it('reads an explicit allowlist, preserving an empty one', () => {
    expect(
      resolveConnectionAllowlist({
        capabilityDiscovery: {
          connections: [{ sourceKind: 'api', integrationId: 'github', bindingId: 'gh-default' }],
        },
      }),
    ).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'github',
        bindingId: 'gh-default',
        placement: 'on_demand',
      },
    ]);
    // `[]` means "no connections", which is different from "unset".
    expect(resolveConnectionAllowlist({ capabilityDiscovery: { connections: [] } })).toEqual([]);
  });

  it('returns undefined when unset, leaving the authored mode alone', () => {
    expect(resolveConnectionAllowlist(undefined)).toBeUndefined();
    expect(resolveConnectionAllowlist({ capabilityDiscovery: {} })).toBeUndefined();
  });

  it('skips malformed entries rather than failing the turn', () => {
    expect(
      resolveConnectionAllowlist({
        capabilityDiscovery: {
          connections: [{ sourceKind: 'ftp', integrationId: 'x' }, { integrationId: 'y' }, null],
        },
      }),
    ).toEqual([]);
  });
});

describe('capability bundles — connection placement', () => {
  const directivesFor = (connections: unknown[]): unknown => ({
    capabilityDiscovery: { connections },
  });

  const etoro = (placement?: string): Record<string, unknown> => ({
    sourceKind: 'api',
    integrationId: 'etoro',
    bindingId: 'etoro-default',
    ...(placement ? { placement } : {}),
  });

  const kaggle = (placement?: string): Record<string, unknown> => ({
    sourceKind: 'mcp',
    integrationId: 'kaggle',
    bindingId: 'kaggle-default',
    ...(placement ? { placement } : {}),
  });

  const config = (coreOperations: string[] = ['memory.store.query']): CatalogConfig => ({
    coreOperations,
    discovery: { allowedOperationIds: ['search.web.search'] },
  });

  it('pins an always_on connection as the exact binding it names', () => {
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([etoro('always_on'), kaggle('always_on')]),
    );
    expect(settings.pinnedConnections).toEqual([
      { sourceKind: 'api', integrationId: 'etoro', bindingId: 'etoro-default' },
      { sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' },
    ]);
    // The integration-keyed tiers stay the agent's own authored declaration —
    // an entry there reaches every binding of the integration, which is reach
    // the allowlist did not grant.
    expect(settings.catalogConfig?.coreApis).toBeUndefined();
    expect(settings.catalogConfig?.coreMcpServers).toBeUndefined();
  });

  it('carries a pinned-tool subset onto the pinned connection', () => {
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([{ ...etoro('always_on'), pinnedToolNames: ['quotes.get'] }]),
    );
    expect(settings.pinnedConnections).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        toolNames: ['quotes.get'],
      },
    ]);
  });

  it('a pinned-tool subset does NOT narrow reach — the unpinned tools stay discoverable', () => {
    // The whole reason the subset is its own field rather than the allowlist's
    // `toolNames`: unticking a tool must cost it the pinned tier, never the
    // ability to be found. Narrowing reach here would silently take endpoints
    // away from an operator who was only managing the tool cap.
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([{ ...etoro('always_on'), pinnedToolNames: ['quotes.get'] }]),
    );
    expect(settings.catalogConfig?.discovery?.integrations?.allowed).toEqual([
      { sourceKind: 'api', integrationId: 'etoro', bindingId: 'etoro-default' },
    ]);
  });

  it('pins nothing for an empty subset — cleared is not the same as unset', () => {
    // Absent = no narrowing = all tools. Empty = narrowed to nothing. Reading
    // empty as "all" would spend the cap on tools the operator just cleared.
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([{ ...etoro('always_on'), pinnedToolNames: [] }]),
    );
    expect(settings.pinnedConnections).toEqual([]);
    // Cleared tools lose the pinned tier, never reach.
    expect(settings.catalogConfig?.discovery?.integrations?.allowed).toEqual([
      { sourceKind: 'api', integrationId: 'etoro', bindingId: 'etoro-default' },
    ]);
  });

  it('leaves an on_demand connection out of the pinned tier', () => {
    // The absent placement is the same case: the schema defaults to on_demand.
    expect(
      applyCapabilitySettings(config(), directivesFor([etoro(), kaggle('on_demand')]))
        .pinnedConnections,
    ).toEqual([]);
  });

  it('leaves an always_on entry naming no binding on demand', () => {
    // Pinning by integration alone would let the agent transact through a
    // sibling binding the allowlist excludes.
    const { integrationId, sourceKind } = etoro('always_on');
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([{ sourceKind, integrationId, placement: 'always_on' }]),
    );
    expect(settings.pinnedConnections).toEqual([]);
    expect(settings.catalogConfig?.discovery?.integrations?.allowed).toEqual([
      { sourceKind: 'api', integrationId: 'etoro' },
    ]);
  });

  it('narrows reach with both placements — pinning is a tier move, not a reach one', () => {
    const settings = applyCapabilitySettings(
      config(),
      directivesFor([etoro('always_on'), kaggle('on_demand')]),
    );
    expect(settings.catalogConfig?.discovery?.integrations).toEqual({
      mode: 'allowlist',
      allowed: [
        { sourceKind: 'api', integrationId: 'etoro', bindingId: 'etoro-default' },
        { sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' },
      ],
    });
    expect(settings.connectionAllowlist?.map((c) => c.placement)).toEqual([
      'always_on',
      'on_demand',
    ]);
  });

  it('pins each binding of one integration separately — they are separate accounts', () => {
    expect(
      applyCapabilitySettings(
        config(),
        directivesFor([
          { ...etoro('always_on'), bindingId: 'etoro-live' },
          { ...etoro('always_on'), bindingId: 'etoro-demo' },
        ]),
      ).pinnedConnections?.map((c) => c.bindingId),
    ).toEqual(['etoro-live', 'etoro-demo']);
  });
});

describe('capability bundles — the pinned connection cap', () => {
  const specsFor = (bindingId: string, count: number): AgentToolSpec[] =>
    Array.from({ length: count }, (_, i) =>
      buildVirtualToolSpec({
        operationId: `api:${bindingId}/ep${String(i)}`,
        stepType: 'api',
        name: `ep${String(i)}`,
        description: 'endpoint',
        inputSchema: { type: 'object' },
        source: 'api',
        lowering: 'api_call',
        apiMeta: { apiId: 'x', endpointId: `ep${String(i)}`, bindingId },
      }),
    );

  it('drops whole connections that do not fit rather than letting the assembler throw', () => {
    // The assembler THROWS past the cap, so an over-long always-on list has to
    // cost the operator tools rather than the run.
    const admitted = admitConnectionsWithinCap(MAX_TOTAL_TOOLS - 10, [
      ...specsFor('big', 13),
      ...specsFor('small', 4),
    ]);
    expect(admitted.map((s) => s.apiMeta?.bindingId)).toEqual(Array<string>(4).fill('small'));
  });

  it('counts tools, not connections — three connections can breach the cap alone', () => {
    const admitted = admitConnectionsWithinCap(24, [
      ...specsFor('stripe', 13),
      ...specsFor('github', 12),
      ...specsFor('linear', 8),
    ]);
    expect(24 + admitted.length).toBeLessThanOrEqual(MAX_TOTAL_TOOLS);
  });
});

describe('capability bundles — what the Helmsman is offered', () => {
  const helmsmanSurface = (() => {
    const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
    const cfg = (
      helmsman?.steps.find((s) => s.operation === 'ai.agent.turn')?.config as
        | {
            catalog?: { coreOperations?: string[]; discovery?: { allowedOperationIds?: string[] } };
          }
        | undefined
    )?.catalog;
    return [...(cfg?.coreOperations ?? []), ...(cfg?.discovery?.allowedOperationIds ?? [])];
  })();

  it('offers nothing the Helmsman cannot reach', () => {
    const offered = bundlesForSurface(helmsmanSurface).map((b) => b.id);
    // The registry is total over the catalog, so it names capability no single
    // agent holds. None of these belong in a Helmsman control.
    for (const absent of ['guardrails', 'agents', 'delegation', 'http']) {
      expect(offered).not.toContain(absent);
    }
  });

  it('offers the bundles it does reach', () => {
    const offered = bundlesForSurface(helmsmanSurface).map((b) => b.id);
    // `evaluations` is offered because the Helmsman holds the agent-permitted
    // eval slice (Plan 269 D7) — dataset reads, draft promotion, batch launch
    // and comparison. Offering it is what lets an operator shed the ruler from
    // the surface entirely; the writes it cannot reach are server routes with
    // no operation behind them.
    for (const present of [
      'memory_read',
      'memory_write',
      'run_skills',
      'author_skills',
      'web',
      'chat',
      'discovery',
      'evaluations',
    ]) {
      expect(offered).toContain(present);
    }
  });

  it('drops a bundle from the offer when its last operation leaves the surface', () => {
    const withoutWeb = helmsmanSurface.filter((id) => !id.startsWith('search.web.'));
    expect(bundlesForSurface(withoutWeb).map((b) => b.id)).not.toContain('web');
  });
});

describe('capability bundles — shedding revokes already-promoted tools', () => {
  const promoted = (): Record<string, VirtualToolEntry> => ({
    'compute.sandbox.exec': { discoveredAtTurn: 3 },
    'memory.store.query': { discoveredAtTurn: 3 },
    'api:github-default/create_issue': { discoveredAtTurn: 2 },
    'mcp:kaggle-default/search': { discoveredAtTurn: 2 },
  });

  it('drops a promoted op whose bundle was shed mid-session', () => {
    const kept = withPromotedToolsRevoked(
      promoted(),
      capabilityGroupsForBundles(['code']),
      undefined,
    );
    expect(kept).not.toHaveProperty('compute.sandbox.exec');
    expect(kept).toHaveProperty('memory.store.query');
  });

  it('keeps integration tools when no connection allowlist is set', () => {
    const kept = withPromotedToolsRevoked(
      promoted(),
      capabilityGroupsForBundles(['code']),
      undefined,
    );
    expect(kept).toHaveProperty('api:github-default/create_issue');
    expect(kept).toHaveProperty('mcp:kaggle-default/search');
  });

  it('drops integration tools outside an explicit connection allowlist', () => {
    const kept = withPromotedToolsRevoked(promoted(), undefined, [
      { sourceKind: 'api', integrationId: 'github', bindingId: 'github-default' },
    ]);
    expect(kept).toHaveProperty('api:github-default/create_issue');
    expect(kept).not.toHaveProperty('mcp:kaggle-default/search');
    // A platform op is untouched by a connections-only change.
    expect(kept).toHaveProperty('compute.sandbox.exec');
  });

  it('revokes every integration tool when connections is explicitly empty', () => {
    const kept = withPromotedToolsRevoked(promoted(), undefined, []);
    expect(kept).not.toHaveProperty('api:github-default/create_issue');
    expect(kept).not.toHaveProperty('mcp:kaggle-default/search');
  });

  it('is a pass-through when nothing is shed and connections are unset', () => {
    const state = promoted();
    expect(withPromotedToolsRevoked(state, undefined, undefined)).toBe(state);
    expect(withPromotedToolsRevoked(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('capability bundles — connection matching is a (sourceKind, bindingId) pair', () => {
  const shared = (): Record<string, VirtualToolEntry> => ({
    'api:shared/create': { discoveredAtTurn: 1 },
    'mcp:shared/search': { discoveredAtTurn: 1 },
  });

  it('does not let an api allowlist entry keep an mcp tool with the same binding id', () => {
    // api and mcp bindings live in separate tables, so ids can collide; a flat
    // string set would keep both alive off one entry.
    const kept = withPromotedToolsRevoked(shared(), undefined, [
      { sourceKind: 'api', integrationId: 'shared', bindingId: 'shared' },
    ]);
    expect(kept).toHaveProperty('api:shared/create');
    expect(kept).not.toHaveProperty('mcp:shared/search');
  });

  it('keeps tools of a source kind whose allowlist entry names no binding', () => {
    // "every binding of this integration" cannot be evaluated from a tool id
    // alone, so revoking would be a guess — and a wrong guess breaks a working
    // agent. The promote path stays authoritative for anything acquired later.
    const kept = withPromotedToolsRevoked(shared(), undefined, [
      { sourceKind: 'mcp', integrationId: 'kaggle' },
    ]);
    expect(kept).toHaveProperty('mcp:shared/search');
    // The api side has an evaluable (empty) set, so it is revoked.
    expect(kept).not.toHaveProperty('api:shared/create');
  });
});

describe('capability bundles — placement', () => {
  it('reads a placement map, and treats malformed config as authored defaults', () => {
    expect(
      resolveBundlePlacements({ capabilityDiscovery: { bundlePlacements: { memory: 'off' } } }),
    ).toEqual({ memory: 'off' });
    expect(resolveBundlePlacements(undefined)).toEqual({});
    expect(resolveBundlePlacements({ capabilityDiscovery: {} })).toEqual({});
    // Stored config can be hand-edited; a wrong shape must not fail the turn.
    expect(resolveBundlePlacements({ capabilityDiscovery: { bundlePlacements: [] } })).toEqual({});
  });

  it('pins an on-demand bundle set always_on, without widening the ceiling', () => {
    const core = ['memory.store.query'];
    const ceiling = ['ui.applet.get', 'ui.applet.list', 'ai.media.video'];
    const placed = applyBundlePlacements(core, ceiling, { applets: 'always_on' });
    expect(placed.coreOperations).toContain('ui.applet.get');
    expect(placed.coreOperations).toContain('ui.applet.list');
    // Untouched bundles stay discoverable, and nothing outside the ceiling appears.
    expect(placed.discoverableOperationIds).toContain('ai.media.video');
    expect(placed.coreOperations).not.toContain('ai.media.video');
  });

  it('unpins a loaded bundle set on_demand, keeping it reachable', () => {
    const placed = applyBundlePlacements(['memory.store.query'], [], { memory_read: 'on_demand' });
    expect(placed.coreOperations).not.toContain('memory.store.query');
    // Authority is unchanged — it moved to the ceiling rather than being removed.
    expect(placed.discoverableOperationIds).toContain('memory.store.query');
  });

  it('removes a bundle set off from both tiers and names its groups', () => {
    // Read and write are separate bundles, so switching reads off must leave
    // the write half exactly where it was.
    const placed = applyBundlePlacements(['memory.store.query'], ['memory.store.delete'], {
      memory_read: 'off',
    });
    expect(placed.coreOperations).toEqual([]);
    expect(placed.discoverableOperationIds).toEqual(['memory.store.delete']);
    expect(placed.offCapabilityGroups.has('memory.store:read')).toBe(true);
  });

  it('ignores any placement stored against a locked bundle', () => {
    const placed = applyBundlePlacements(['human.chat.ask', 'catalog.tool.search'], [], {
      chat: 'off',
      discovery: 'on_demand',
    });
    expect(placed.coreOperations).toContain('human.chat.ask');
    expect(placed.coreOperations).toContain('catalog.tool.search');
  });
});
