import { resolveJsonPointer } from '@aflow/applet-runtime';
import type { SimulationRule } from '@aflow/schemas';
import type { SimulatedRequest, WorldReadQuery, WorldStore } from './types.js';

/**
 * Rung 1. One ordered list, first match wins.
 *
 * Fixtures and failure scenarios are the same rule — both match a resolved
 * request and produce a declared response, a failure adding only an ordinal
 * and an optional transition. A second authoring surface bought nothing but a
 * precedence order to explain.
 */

/** The document a rule's `args` pointers resolve against. */
function matchDocument(request: SimulatedRequest): Record<string, unknown> {
  return { params: request.params, body: request.body };
}

function argsMatch(rule: SimulationRule, request: SimulatedRequest): boolean {
  for (const arg of rule.when.args ?? []) {
    const resolved = resolveJsonPointer(matchDocument(request), arg.path);
    if (!resolved.found) return false;
    if (resolved.value !== arg.equals) return false;
  }
  return true;
}

async function worldStateMatches(rule: SimulationRule, store: WorldStore): Promise<boolean> {
  for (const condition of rule.when.worldState ?? []) {
    const query: WorldReadQuery = { collection: condition.collection, match: [], limit: 1 };
    if (condition.identity !== undefined) query.entityId = condition.identity;
    const rows = await store.query(query);
    if (rows.length > 0 !== condition.exists) return false;
  }
  return true;
}

export async function matchRule(params: {
  rules: readonly SimulationRule[];
  request: SimulatedRequest;
  ordinal: number;
  store: WorldStore;
}): Promise<SimulationRule | undefined> {
  for (const rule of params.rules) {
    if (rule.when.endpointId !== params.request.endpointId) continue;
    if (rule.when.ordinal !== undefined && rule.when.ordinal !== params.ordinal) continue;
    if (!argsMatch(rule, params.request)) continue;
    if (!(await worldStateMatches(rule, params.store))) continue;
    return rule;
  }
  return undefined;
}
