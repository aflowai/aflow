import { describe, it, expect } from 'vitest';
import { mapMcpToolToToolSpec, type McpCachedTool } from '@aflow/schemas';
import { mapGrantedMcpToolsToToolSpecs, type McpGrantContext } from './mcpToolMapper.js';

function tool(name: string, overrides: Partial<McpCachedTool> = {}): McpCachedTool {
  return {
    name,
    description: `Description of ${name}`,
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  } as McpCachedTool;
}

describe('mapMcpToolToToolSpec (coreMcpServers path)', () => {
  it('builds the canonical server-scoped toolId + callName', () => {
    const spec = mapMcpToolToToolSpec('kaggle', 'Kaggle', tool('search_datasets'));
    expect(spec.toolId).toBe('mcp:kaggle/search_datasets');
    expect(spec.callName).toBe('mcp_kaggle.search_datasets');
    expect(spec.lowering).toBe('mcp_call');
    expect(spec.source).toBe('mcp');
    expect(spec.stepType).toBe('mcp');
    expect(spec.mcpMeta).toEqual({ serverId: 'kaggle', toolName: 'search_datasets' });
  });

  it('carries through the cached inputSchema', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const spec = mapMcpToolToToolSpec(
      'kaggle',
      'Kaggle',
      tool('search_datasets', { inputSchema: schema }),
    );
    expect(spec.inputSchema).toEqual(schema);
  });

  it('falls back to an empty object schema when the cache has none', () => {
    const spec = mapMcpToolToToolSpec(
      'kaggle',
      'Kaggle',
      tool('search_datasets', { inputSchema: undefined }),
    );
    expect(spec.inputSchema).toEqual({ type: 'object' });
  });

  it('falls back to a synthetic description when none is cached', () => {
    const spec = mapMcpToolToToolSpec(
      'kaggle',
      'Kaggle',
      tool('search_datasets', { description: undefined }),
    );
    expect(spec.description).toBe('MCP tool from Kaggle');
  });

  it('omits governance when opTaskOnly is false', () => {
    const spec = mapMcpToolToToolSpec('kaggle', 'Kaggle', tool('search_datasets'));
    expect(spec.governance).toBeUndefined();
  });

  it('sets governance.opTaskOnly when the definition marks this tool op-task-only', () => {
    const spec = mapMcpToolToToolSpec('kaggle', 'Kaggle', tool('delete_dataset'), true);
    expect(spec.governance).toEqual({ sideEffects: true, opTaskOnly: true });
  });
});

describe('mapGrantedMcpToolsToToolSpecs (task-grant path)', () => {
  function grant(overrides: Partial<McpGrantContext> = {}): McpGrantContext {
    return {
      capabilityId: 'kaggle-cap',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      grantedToolNames: new Set(['search_datasets']),
      allTools: false,
      useQualifiedName: false,
      ...overrides,
    };
  }

  it('filters to only granted tool names', () => {
    const tools = [tool('search_datasets'), tool('get_dataset'), tool('delete_dataset')];
    const specs = mapGrantedMcpToolsToToolSpecs('Kaggle', tools, grant());
    expect(specs).toHaveLength(1);
    expect(specs[0]!.toolId).toBe('mcp:kaggle-default/search_datasets');
  });

  it('promotes all tools when allTools is true', () => {
    const tools = [tool('a'), tool('b'), tool('c')];
    const specs = mapGrantedMcpToolsToToolSpecs(
      'Kaggle',
      tools,
      grant({ allTools: true, grantedToolNames: new Set() }),
    );
    expect(specs.map((s) => s.mcpMeta!.toolName)).toEqual(['a', 'b', 'c']);
  });

  it('returns no specs when grant is empty and not broad', () => {
    const tools = [tool('a'), tool('b')];
    const specs = mapGrantedMcpToolsToToolSpecs(
      'Kaggle',
      tools,
      grant({ grantedToolNames: new Set(), allTools: false }),
    );
    expect(specs).toEqual([]);
  });

  it('uses bindingId in the toolId for collision-free naming across bindings', () => {
    const specs = mapGrantedMcpToolsToToolSpecs('Kaggle', [tool('search_datasets')], grant());
    expect(specs[0]!.toolId).toBe('mcp:kaggle-default/search_datasets');
  });

  it('callName uses serverId prefix when single-binding (useQualifiedName=false)', () => {
    const specs = mapGrantedMcpToolsToToolSpecs(
      'Kaggle',
      [tool('search_datasets')],
      grant({ useQualifiedName: false }),
    );
    expect(specs[0]!.callName).toBe('mcp_kaggle.search_datasets');
  });

  it('callName uses capabilityId prefix when multi-binding (useQualifiedName=true)', () => {
    const specs = mapGrantedMcpToolsToToolSpecs(
      'Kaggle',
      [tool('search_datasets')],
      grant({ useQualifiedName: true }),
    );
    expect(specs[0]!.callName).toBe('mcp_kaggle-cap.search_datasets');
  });

  it('mcpMeta includes bindingId + capabilityId for lowering', () => {
    const specs = mapGrantedMcpToolsToToolSpecs('Kaggle', [tool('search_datasets')], grant());
    expect(specs[0]!.mcpMeta).toEqual({
      serverId: 'kaggle',
      toolName: 'search_datasets',
      bindingId: 'kaggle-default',
      capabilityId: 'kaggle-cap',
    });
  });

  it('sets governance.opTaskOnly only for tools in the opTaskOnly set', () => {
    const tools = [tool('search_datasets'), tool('delete_dataset')];
    const specs = mapGrantedMcpToolsToToolSpecs(
      'Kaggle',
      tools,
      grant({
        allTools: true,
        grantedToolNames: new Set(),
        opTaskOnlyToolNames: new Set(['delete_dataset']),
      }),
    );
    const byName = new Map(specs.map((s) => [s.mcpMeta!.toolName, s]));
    expect(byName.get('search_datasets')!.governance).toBeUndefined();
    expect(byName.get('delete_dataset')!.governance).toEqual({
      sideEffects: true,
      opTaskOnly: true,
    });
  });
});
