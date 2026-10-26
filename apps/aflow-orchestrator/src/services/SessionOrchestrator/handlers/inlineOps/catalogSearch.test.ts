import { describe, expect, it } from 'vitest';
import { matchAgentCandidates, scoreIntegrationTools } from './catalogSearch.js';
import type { AgentId, SystemRole } from '@aflow/schemas';
import type { IntegrationToolDescriptor } from '@aflow/schemas';

const apiTool = (
  overrides: Partial<IntegrationToolDescriptor> = {},
): IntegrationToolDescriptor => ({
  sourceKind: 'api',
  integrationId: 'alpaca',
  bindingId: 'alpaca-default',
  toolName: 'get_bars',
  toolId: 'api:alpaca-default/get_bars',
  callName: 'alpaca.get_bars',
  name: 'get_bars',
  description: 'Get stock bars for a symbol',
  inputSchema: { type: 'object', properties: { symbol: {} } },
  ...overrides,
});

const mcpTool = (
  overrides: Partial<IntegrationToolDescriptor> = {},
): IntegrationToolDescriptor => ({
  sourceKind: 'mcp',
  integrationId: 'kaggle',
  bindingId: 'kaggle-default',
  toolName: 'search_competitions',
  toolId: 'mcp:kaggle-default/search_competitions',
  callName: 'mcp_kaggle.search_competitions',
  name: 'search_competitions',
  description: 'Search for Kaggle competitions',
  inputSchema: { type: 'object', properties: { query: {} } },
  ...overrides,
});

describe('scoreIntegrationTools', () => {
  const names = new Map<string, string>([
    ['api:alpaca', 'Alpaca'],
    ['mcp:kaggle', 'Kaggle'],
  ]);

  it('ranks tools matching the query above non-matching ones', () => {
    const tools = [apiTool(), mcpTool()];
    const out = scoreIntegrationTools(tools, names, ['competitions'], 3);
    expect(out[0]?.sourceKind).toBe('mcp');
    expect(out[0]?.toolName).toBe('search_competitions');
  });

  it('returns mixed API + MCP results when both match', () => {
    const tools = [apiTool({ description: 'Stock prices and market data' }), mcpTool()];
    const out = scoreIntegrationTools(tools, names, ['stock', 'competitions'], 3);
    const kinds = out.map((r) => r.sourceKind);
    expect(kinds).toContain('api');
    expect(kinds).toContain('mcp');
  });

  it('enforces per-source-kind quota (max N per kind)', () => {
    const tools = [
      apiTool({ toolId: 'api:alpaca-default/get_bars', toolName: 'get_bars' }),
      apiTool({
        toolId: 'api:alpaca-default/list_positions',
        toolName: 'list_positions',
        name: 'list_positions',
        description: 'List open positions',
      }),
      apiTool({
        toolId: 'api:alpaca-default/place_order',
        toolName: 'place_order',
        name: 'place_order',
        description: 'Place an order',
      }),
      apiTool({
        toolId: 'api:alpaca-default/cancel_order',
        toolName: 'cancel_order',
        name: 'cancel_order',
        description: 'Cancel an order',
      }),
      mcpTool(),
    ];
    const out = scoreIntegrationTools(tools, names, ['order', 'positions', 'bars'], 2);
    const apiResults = out.filter((r) => r.sourceKind === 'api');
    expect(apiResults.length).toBeLessThanOrEqual(2);
  });

  it('preserves canonical toolId / callName / opTaskOnly from descriptor', () => {
    const tools = [
      mcpTool({
        toolId: 'mcp:kaggle-default/submit_entry',
        toolName: 'submit_entry',
        name: 'submit_entry',
        description: 'Submit competition entry',
        callName: 'mcp_kaggle.submit_entry',
        opTaskOnly: true,
      }),
    ];
    const out = scoreIntegrationTools(tools, names, ['submit', 'entry'], 3);
    expect(out[0]?.toolId).toBe('mcp:kaggle-default/submit_entry');
    expect(out[0]?.callName).toBe('mcp_kaggle.submit_entry');
    expect(out[0]?.opTaskOnly).toBe(true);
  });

  it('drops tools that match no query tokens', () => {
    const tools = [apiTool(), mcpTool()];
    const out = scoreIntegrationTools(tools, names, ['nothing-matches-this'], 3);
    expect(out).toEqual([]);
  });

  it('uses integration name from descriptor lookup map for matching', () => {
    // Tool description doesn't mention "Alpaca" but the integration name does.
    const tools = [apiTool({ description: 'Returns historical price bars', toolName: 'bars' })];
    const out = scoreIntegrationTools(tools, names, ['alpaca'], 3);
    expect(out).toHaveLength(1);
    expect(out[0]?.matchReason).toMatch(/Alpaca/);
  });
});

describe('matchAgentCandidates', () => {
  const shepherd = {
    target: {
      kind: 'custom-agent' as const,
      agentId: 'a0000000-0000-4000-8000-000000000001' as AgentId,
    },
    displayKey: 'local-pr-shepherd',
    name: 'Local PR Shepherd',
    description:
      'Starts one pass of the Local PR Shepherd on each connected folder that allows pushes.',
  };
  const roles = ['helmsman', 'coach', 'runner', 'local-reviewer'].map((role) => ({
    target: { kind: 'platform-role' as const, systemRole: role as SystemRole },
    displayKey: role,
    name: `${role} local pass`,
    description: 'A platform role',
  }));

  it('finds a space agent by its slug, with the target that carries its id', () => {
    const [first] = matchAgentCandidates([...roles, shepherd], 'local-pr-shepherd');
    expect(first?.target).toEqual(shepherd.target);
    expect(first?.slug).toBe('local-pr-shepherd');
    expect(first?.matchReason).toContain('is the handle');
  });

  it('finds it by its name, ahead of agents that share only a word of it', () => {
    const results = matchAgentCandidates([...roles, shepherd], 'Local PR Shepherd');
    expect(results[0]?.target).toEqual(shepherd.target);
    expect(results[0]?.matchReason).toContain('is the name');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('gives a platform role no slug, and drops what matches nothing', () => {
    expect(matchAgentCandidates(roles, 'coach')[0]?.slug).toBeUndefined();
    expect(matchAgentCandidates([shepherd], 'kaggle')).toEqual([]);
  });
});
