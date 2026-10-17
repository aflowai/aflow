/**
 * Plan 323 D10 — the model runtime on this computer is reached by Helmsman
 * alone, its read pinned on the local edition, and by no skill: a run does not
 * reconfigure the machine it runs on. Probed with a violation, so the test
 * fails the moment the rule admits one.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import {
  getOperation,
  isLocalModelOperation,
  isRunnerExcludedOperation,
  MODEL_RUNTIME_CHANGE_OPERATION_ID,
  MODEL_RUNTIME_STATUS_OPERATION_ID,
} from '@aflow/schemas';
import {
  LOCAL_MODEL_TASK_ERROR,
  materializeAndValidateSkillConfig,
} from '@aflow/cybernetic-runtime';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';
import { composeHelmsmanSurface } from '../helmsmanSurface.js';

const MODEL_OPS = [MODEL_RUNTIME_STATUS_OPERATION_ID, MODEL_RUNTIME_CHANGE_OPERATION_ID];

function catalogOf(flowId: string): { coreOperations: string[]; allowedOperationIds: string[] } {
  const agent = CYBERNETIC_AGENTS.find((a) => a.flowId === flowId);
  const step = (agent?.steps as Array<Record<string, unknown>> | undefined)?.find(
    (s) => s['stepId'] === 'agent',
  );
  const catalog = (step?.['config'] as Record<string, unknown> | undefined)?.['catalog'] as
    { coreOperations?: string[]; discovery?: { allowedOperationIds?: string[] } } | undefined;
  return {
    coreOperations: catalog?.coreOperations ?? [],
    allowedOperationIds: catalog?.discovery?.allowedOperationIds ?? [],
  };
}

const LOCAL = {
  edition: 'community-local',
  codeLane: 'present',
  hostLane: 'present',
  browserLane: 'present',
} as const;
const HOSTED = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'absent',
  browserLane: 'absent',
} as const;

describe('the model runtime is Helmsman’s, never a Runner’s (Plan 323 D10)', () => {
  it('lets Helmsman discover both operations, each a callable agent tool', () => {
    const helmsman = catalogOf('cybernetic-helmsman');
    expect(helmsman.allowedOperationIds.filter(isLocalModelOperation).sort()).toEqual(
      [...MODEL_OPS].sort(),
    );
    for (const id of MODEL_OPS) {
      expect(getOperation(id)?.agentTool, id).toBe(true);
      expect(isRunnerExcludedOperation(id), id).toBe(true);
    }
  });

  it('pins the status read on the local edition, and composes neither in the hosted one', () => {
    const helmsman = catalogOf('cybernetic-helmsman');
    const authored = {
      coreOperations: helmsman.coreOperations,
      promotableOperations: helmsman.allowedOperationIds,
    };
    const local = composeHelmsmanSurface(authored, LOCAL);
    expect(local.coreOperations).toContain(MODEL_RUNTIME_STATUS_OPERATION_ID);
    expect(local.promotableOperations).toContain(MODEL_RUNTIME_CHANGE_OPERATION_ID);
    const hosted = composeHelmsmanSurface(authored, HOSTED);
    expect(
      [...hosted.coreOperations, ...hosted.promotableOperations].filter(isLocalModelOperation),
    ).toEqual([]);
  });

  it('gives no other platform agent one', () => {
    for (const agent of CYBERNETIC_AGENTS) {
      if (agent.flowId === 'cybernetic-helmsman') continue;
      const { coreOperations, allowedOperationIds } = catalogOf(agent.flowId);
      expect(
        [...coreOperations, ...allowedOperationIds].filter(isLocalModelOperation),
        agent.flowId,
      ).toEqual([]);
    }
  });

  it('refuses a skill whose Runner references model.runtime.change', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        {
          taskId: 'runner',
          name: 'Runner',
          type: 'agent',
          goal: 'Free the machine.',
          dependsOn: [],
          context: { strategy: 'static', tools: ['model.runtime.change'] },
        } as unknown as WorkflowTask,
      ],
    });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'skill_references_local_model_op',
        detail: LOCAL_MODEL_TASK_ERROR.replace('{opId}', 'model.runtime.change'),
      }),
    );
  });
});
