import { describe, expect, it } from 'vitest';
import { getAllOperations } from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';

function findHelmsman() {
  const h = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
  if (!h) throw new Error('cybernetic-helmsman not found in CYBERNETIC_AGENTS');
  return h;
}

describe('Helmsman config — Plan 155 §11 integration contract', () => {
  it('ships catalog.tool.promote in coreOperations', () => {
    const helmsman = findHelmsman();
    const agentTurnStep = helmsman.steps.find(
      (s): s is typeof s & { catalog?: { coreOperations?: string[] } } =>
        s.operation === 'ai.agent.turn',
    );
    expect(agentTurnStep).toBeDefined();
    const core = (agentTurnStep as unknown as { config: { catalog: { coreOperations: string[] } } })
      .config.catalog.coreOperations;
    expect(core).toContain('catalog.tool.promote');
    expect(core).toContain('catalog.tool.search');
    expect(core).toContain('catalog.tool.list');
  });

  it('integration.registry.lookup + list are discoverable, not pinned (context injects the inventory)', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const catalog = (
      step as unknown as {
        config: {
          catalog: { coreOperations: string[]; discovery?: { allowedOperationIds?: string[] } };
        };
      }
    ).config.catalog;
    // SpaceContext already injects the integrations inventory every turn, so the
    // registry read ops are discoverable (hinted next to that inventory), not pinned.
    for (const op of ['integration.registry.lookup', 'integration.registry.list']) {
      expect(catalog.coreOperations).not.toContain(op);
      expect(catalog.discovery?.allowedOperationIds).toContain(op);
    }
  });

  it('does NOT carry the legacy capability.registry.lookup', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const core = (step as unknown as { config: { catalog: { coreOperations: string[] } } }).config
      .catalog.coreOperations;
    expect(core).not.toContain('capability.registry.lookup');
  });

  it('configures discovery.integrations.mode = "bound" for api + mcp', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const discovery = (
      step as unknown as {
        config: {
          catalog: {
            discovery?: {
              integrations?: { mode: string; sourceKinds?: Array<'api' | 'mcp'> };
            };
          };
        };
      }
    ).config.catalog.discovery;
    expect(discovery?.integrations?.mode).toBe('bound');
    expect(discovery?.integrations?.sourceKinds).toEqual(['api', 'mcp']);
  });

  it('keeps platform-op discovery separate from integration scope — op-level allow-list has no api/mcp ops (Plan 233 Part 3)', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const discovery = (
      step as unknown as {
        config: { catalog: { discovery?: { allowedOperationIds?: string[] } } };
      }
    ).config.catalog.discovery;
    const allowed = discovery?.allowedOperationIds;
    expect(allowed).toBeDefined();
    // Integration discovery is its own authority (discovery.integrations). The
    // platform-op ceiling carries read-only api/mcp *inspection* ops, never
    // api.http.call / mcp.tool.call — those go through the pinned core / bound
    // integration path, not ad-hoc promotion.
    expect(allowed).not.toContain('api.http.call');
    expect(allowed).not.toContain('mcp.tool.call');
  });

  it('MCP + API management ops are discoverable, not pinned (Plan 233 Part 3 — occasional setup)', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const catalog = (
      step as unknown as {
        config: {
          catalog: { coreOperations: string[]; discovery?: { allowedOperationIds?: string[] } };
        };
      }
    ).config.catalog;
    // Integration management is occasional setup — not on every turn — so it
    // lives in the discoverable preset, hinted next to the SpaceContext
    // integrations inventory, not pinned in coreOperations.
    for (const op of [
      'mcp.binding.list',
      'mcp.binding.get',
      'mcp.binding.upsert',
      'api.binding.upsert',
    ]) {
      expect(catalog.coreOperations).not.toContain(op);
      expect(catalog.discovery?.allowedOperationIds).toContain(op);
    }
  });

  it('store listing ops are discoverable, not pinned — install stays proposal-gated by the op', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const catalog = (
      step as unknown as {
        config: {
          catalog: { coreOperations: string[]; discovery?: { allowedOperationIds?: string[] } };
        };
      }
    ).config.catalog;
    // The discovery ceiling is an explicit allow-list, so store.listing.install
    // must be listed to be promotable at all; the op itself only ever emits a
    // require_operator StagedChange, so listing it grants propose authority,
    // never install authority.
    for (const op of ['store.listing.search', 'store.listing.get', 'store.listing.install']) {
      expect(catalog.coreOperations).not.toContain(op);
      expect(catalog.discovery?.allowedOperationIds).toContain(op);
    }
  });

  it('ships the Plan 156 human.* HITL tools in coreOperations', () => {
    const helmsman = findHelmsman();
    const step = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    const core = (step as unknown as { config: { catalog: { coreOperations: string[] } } }).config
      .catalog.coreOperations;
    expect(core).toContain('human.chat.ask');
    expect(core).toContain('human.action_center.focus');
  });
});

describe('Helmsman simulation authoring — Plan 293 §5.10', () => {
  /**
   * Every operation that authors or reads a simulation, so a new verb is
   * reachable the day it is registered rather than the day someone remembers
   * this list.
   */
  function simulationOperationIds(): string[] {
    return [...getAllOperations().values()]
      .filter((op) => op.capabilityGroupId === 'integration.simulation')
      .map((op) => op.operationId);
  }

  function helmsmanCatalog() {
    const step = findHelmsman().steps.find((s) => s.operation === 'ai.agent.turn');
    return (
      step as unknown as {
        config: {
          catalog: { coreOperations: string[]; discovery?: { allowedOperationIds?: string[] } };
        };
      }
    ).config.catalog;
  }

  it('can reach every simulation operation', () => {
    // The discovery ceiling is an explicit allow-list, so an operation absent
    // from it is one the Helmsman cannot promote at all — a simulation would be
    // authorable only through the operator's own screens.
    const catalog = helmsmanCatalog();
    const unreachable = simulationOperationIds().filter(
      (op) =>
        !catalog.coreOperations.includes(op) &&
        !(catalog.discovery?.allowedOperationIds ?? []).includes(op),
    );
    expect(unreachable).toEqual([]);
  });

  it('pins none of them, leaving the acting surface identical for both fulfillments', () => {
    // A bound tool must look the same whichever way its binding is fulfilled.
    // Pinning a simulation op would put "this space has simulations" in front of
    // every turn, including the turns being measured.
    const catalog = helmsmanCatalog();
    const pinned = simulationOperationIds().filter((op) => catalog.coreOperations.includes(op));
    expect(pinned).toEqual([]);
  });
});
