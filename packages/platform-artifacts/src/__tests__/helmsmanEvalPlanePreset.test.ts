/**
 * Plan 269 D7 — the Helmsman holds exactly the agent-permitted eval-plane
 * slice: dataset reads + draft promotion, discoverable (not pinned). Every
 * one of them must resolve in the registry as a plain agent tool, and no
 * other eval.* op may creep into the preset without landing in the D7
 * authority table first.
 */
import { describe, expect, it } from 'vitest';
import { getOperation, getOperationsByStepType } from '@aflow/schemas';
import { HELMSMAN_DISCOVERY_PRESET } from '../cyberneticAgents.js';

const AGENT_PERMITTED_EVAL_OPS = [
  'eval.dataset.get',
  'eval.dataset.list',
  'eval.case.promote',
  'eval.batch.run',
  'eval.batch.get',
  'eval.batch.compare',
  'eval.batch.list',
];

describe('Helmsman discovery preset × eval plane', () => {
  it('contains exactly the agent-permitted eval ops', () => {
    const evalOps = HELMSMAN_DISCOVERY_PRESET.filter((id) => id.startsWith('eval.')).sort();
    expect(evalOps).toEqual([...AGENT_PERMITTED_EVAL_OPS].sort());
  });

  it('every registered eval op is reachable by design — by an agent, or by the engine', () => {
    // An op in neither place would be dead. The two paths are not
    // interchangeable: an agent-callable op is on the Helmsman's surface, and
    // an `opTaskOnly` one is a skill's task and deliberately off it, which is
    // what keeps case PROPOSAL out of an agent's reach while leaving the
    // measurement reads in it.
    const registered = [...getOperationsByStepType('eval').keys()];
    const engineOnly = registered.filter((id) => getOperation(id)?.opTaskOnly === true);
    const agentFacing = registered.filter((id) => !engineOnly.includes(id));

    expect(agentFacing.sort()).toEqual([...AGENT_PERMITTED_EVAL_OPS].sort());
    expect(engineOnly.sort()).toEqual(['eval.case.propose']);
    for (const id of engineOnly) {
      expect(HELMSMAN_DISCOVERY_PRESET, id).not.toContain(id);
    }
  });

  it('each preset eval op resolves as a callable agent tool', () => {
    for (const id of AGENT_PERMITTED_EVAL_OPS) {
      const op = getOperation(id);
      expect(op, id).toBeDefined();
      expect(op?.agentTool, id).toBe(true);
      expect(op?.opTaskOnly, id).toBe(false);
    }
  });
});
