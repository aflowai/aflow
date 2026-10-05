/**
 * Plan 322 D3 — the plan is the Helmsman's: its four P0 operations are pinned
 * on the Helmsman's every-turn surface, and no skill may reach any of them. The
 * rule is a skill-validity rule, and this probes it with a violation, so the
 * test fails the moment the rule admits one.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import { buildOperationId, getOperation, isPlanOperation } from '@aflow/schemas';
import {
  materializeAndValidateSkillConfig,
  PLAN_TASK_ERROR,
  validateSkillPlanSeparation,
} from '@aflow/cybernetic-runtime';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';
import { ALL_PLATFORM_WORKFLOWS } from '../skillBundles.js';
import { SKILL_CATALOG } from '../skillCatalog.js';

const PLAN_OPS = ['create', 'update', 'get', 'list'].map((verb) =>
  buildOperationId('plan', 'node', verb),
);

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

function skillWithRunnerTools(tools: string[]): WorkflowTask[] {
  return [
    {
      taskId: 'runner',
      name: 'Runner',
      type: 'agent',
      goal: 'Work the node.',
      dependsOn: [],
      context: { strategy: 'static', tools },
    } as unknown as WorkflowTask,
  ];
}

describe('the plan is the Helmsman’s, never a Runner’s (Plan 322 D3)', () => {
  it('pins exactly the four plan operations on the Helmsman, each a callable agent tool', () => {
    const helmsman = catalogOf('cybernetic-helmsman');
    expect(helmsman.coreOperations.filter(isPlanOperation).sort()).toEqual([...PLAN_OPS].sort());
    for (const id of PLAN_OPS) {
      const op = getOperation(id);
      expect(op?.agentTool, id).toBe(true);
      expect(op?.opTaskOnly, id).toBe(false);
    }
  });

  it('gives no other platform agent a plan operation', () => {
    for (const agent of CYBERNETIC_AGENTS) {
      if (agent.flowId === 'cybernetic-helmsman') continue;
      const { coreOperations, allowedOperationIds } = catalogOf(agent.flowId);
      expect(
        [...coreOperations, ...allowedOperationIds].filter(isPlanOperation),
        agent.flowId,
      ).toEqual([]);
    }
  });

  it('refuses a skill whose Runner references plan.node.update', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: skillWithRunnerTools(['memory.store.get', 'plan.node.update']),
    });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'skill_references_plan_op',
        severity: 'error',
        detail: PLAN_TASK_ERROR.replace('{opId}', 'plan.node.update'),
      }),
    );
  });

  it('finds no plan operation in any bundled skill', () => {
    const workflows = [
      ...ALL_PLATFORM_WORKFLOWS,
      ...SKILL_CATALOG.flatMap((entry) => {
        const wf = (entry as unknown as { bundle?: { workflow?: unknown } }).bundle?.workflow;
        return wf ? [wf] : [];
      }),
    ] as Array<{ slug: string; tasks?: WorkflowTask[] }>;
    expect(workflows.length).toBeGreaterThan(0);
    for (const wf of workflows) {
      expect(validateSkillPlanSeparation(wf.tasks ?? []), wf.slug).toBeNull();
    }
  });
});
