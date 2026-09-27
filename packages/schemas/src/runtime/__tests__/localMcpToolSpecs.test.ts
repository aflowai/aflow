/**
 * Contract: a tool on the operator's machine is the same tool, routed
 * differently. Only where the call is carried out may differ.
 */
import { describe, expect, it } from 'vitest';

import { mapMcpToolToToolSpec } from '../integrationToolSpecs.js';

const tool = {
  name: 'query',
  description: 'Run SQL against the project database.',
  inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
};

describe('a local MCP tool on the agent surface', () => {
  it('carries the server own schema, not one derived here', () => {
    // The point of a named tool over a generic call: the model gets the
    // server's argument shape and can form a correct call the first time.
    const spec = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_project');
    expect(spec.inputSchema).toEqual(tool.inputSchema);
    expect(spec.description).toBe(tool.description);
  });

  it('records where it lives, which is what the lowering reads', () => {
    const spec = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_project');
    expect(spec.mcpMeta?.hostBindingId).toBe('hb_project');
    expect(spec.mcpMeta?.serverId).toBe('sqlite');
    expect(spec.mcpMeta?.toolName).toBe('query');
  });

  it('does not claim a host binding when the server is remote', () => {
    const spec = mapMcpToolToToolSpec('stripe', 'Stripe', tool, false, 'bind_1');
    expect(spec.mcpMeta?.hostBindingId).toBeUndefined();
    expect(spec.mcpMeta?.bindingId).toBe('bind_1');
  });

  it('does not collide with the same server offered by another folder', () => {
    // A monorepo and a side project can each offer `sqlite`. An unqualified
    // name leaves one shadowing the other, with nothing to show a tool went
    // missing.
    const a = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_monorepo');
    const b = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_sideproject');
    expect(a.callName).not.toBe(b.callName);
    expect(a.toolId).not.toBe(b.toolId);
  });

  it('does not collide with a remote server of the same name', () => {
    // An operator may run a local `sqlite` while a hosted `sqlite` is bound.
    // Two tools sharing a call name would make the model's choice ambiguous
    // and one of them unreachable.
    const local = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_project');
    const remote = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, 'bind_1');
    expect(local.callName).not.toBe(remote.callName);
    expect(local.toolId).not.toBe(remote.toolId);
  });

  it('keeps the tool name recoverable from the toolId, as the lowering parses it', () => {
    const spec = mapMcpToolToToolSpec('sqlite', 'SQLite', tool, false, undefined, 'hb_project');
    const body = spec.toolId.slice('mcp:'.length);
    expect(body.slice(body.indexOf('/') + 1)).toBe('query');
  });
});
