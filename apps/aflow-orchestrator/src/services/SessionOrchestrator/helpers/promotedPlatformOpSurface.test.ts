/**
 * A promoted platform operation reaches the agent's surface from its
 * `_virtualTools` entry alone.
 *
 * This covers materialization only, which is the half that was never at fault.
 * When a promoted operation stopped being callable, the cause was a third
 * authority: the surface filters every tool through the run's capability grant
 * on the way out, and dropped it there after promotion had said yes. Promotion
 * asks that same predicate now, so the two answer together — see
 * `checkGrantAdmitsOp`.
 *
 * Keeping this narrow is the point. It asserts what the builder does with a
 * state it is handed, and deliberately says nothing about whether the grant
 * admits the result; a test that claimed both would have gone green while the
 * product looped.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDefinition, VirtualToolEntry } from '@aflow/schemas';
import { getOperation } from '@aflow/schemas';
import { buildAvailableTools } from './agentTurn.js';

const PROMOTED_OP = 'compute.sandbox.exec';

function makeAgent(): AgentDefinition {
  return {
    schemaVersion: 1,
    flowId: 'surface-probe',
    version: '1',
    metadata: { name: 'Surface probe', description: '' },
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

describe('a promoted platform operation', () => {
  it('is one the registry offers to agents at all', () => {
    const op = getOperation(PROMOTED_OP);
    expect(op).toBeDefined();
    expect(op?.internal).not.toBe(true);
    expect(op?.agentTool).toBe(true);
  });

  it('reaches the surface from nothing but its `_virtualTools` entry', () => {
    const virtualToolsState: Record<string, VirtualToolEntry> = {
      [PROMOTED_OP]: { discoveredAtTurn: 2 },
    };

    const tools = buildAvailableTools(makeAgent(), 'agent', {}, virtualToolsState);

    expect(tools.map((t) => t.toolId)).toContain(PROMOTED_OP);
  });
});
