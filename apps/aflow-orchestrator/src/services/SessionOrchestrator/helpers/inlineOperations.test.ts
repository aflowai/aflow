import { describe, expect, it } from 'vitest';
import { getAllOperations } from '@aflow/schemas';
import { isInlineOperation } from './inlineOperations.js';

describe('isInlineOperation', () => {
  it('recognizes integration.registry.lookup as inline (Plan 155 §9)', () => {
    expect(isInlineOperation('integration.registry.lookup')).toBe(true);
  });

  it('recognizes integration.registry.list as inline (Plan 155 §9)', () => {
    expect(isInlineOperation('integration.registry.list')).toBe(true);
  });

  it('does NOT recognize the renamed-away capability.registry.lookup', () => {
    expect(isInlineOperation('capability.registry.lookup')).toBe(false);
  });

  it('still recognizes capability.binding.propose (104g) — not regressed', () => {
    expect(isInlineOperation('capability.binding.propose')).toBe(true);
  });

  it('recognizes the store.listing.* discovery-and-propose ops as inline', () => {
    expect(isInlineOperation('store.listing.search')).toBe(true);
    expect(isInlineOperation('store.listing.get')).toBe(true);
    expect(isInlineOperation('store.listing.install')).toBe(true);
  });

  it('still recognizes skill.compose.prepare_surface and assemble', () => {
    expect(isInlineOperation('skill.compose.prepare_surface')).toBe(true);
    expect(isInlineOperation('skill.compose.assemble_workflow')).toBe(true);
  });

  it('routes every registered integration.simulation.* op', () => {
    // Derived from the registry rather than listed: an operation the catalog
    // advertises and nothing routes fails at dispatch with no earlier signal.
    const registered = [...getAllOperations().keys()].filter((id) =>
      id.startsWith('integration.simulation.'),
    );
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((id) => !isInlineOperation(id))).toEqual([]);
  });

  it('does not match unrelated operation prefixes', () => {
    expect(isInlineOperation('ai.agent.turn')).toBe(false);
    expect(isInlineOperation('memory.store.put')).toBe(false);
    expect(isInlineOperation('compute.sandbox.exec')).toBe(false);
  });

  it('recognizes Plan 103 MCP inline ops', () => {
    expect(isInlineOperation('mcp.tool.discover')).toBe(true);
    expect(isInlineOperation('mcp.tool.promote')).toBe(true);
    expect(isInlineOperation('mcp.binding.consent')).toBe(true);
  });

  it('does NOT mark executor-routed mcp ops as inline', () => {
    // These belong on the MCP executor — they need warm sessions.
    expect(isInlineOperation('mcp.tool.call')).toBe(false);
    expect(isInlineOperation('mcp.tool.list')).toBe(false);
    expect(isInlineOperation('mcp.binding.test')).toBe(false);
    expect(isInlineOperation('mcp.server.refresh_tools')).toBe(false);
  });
});
