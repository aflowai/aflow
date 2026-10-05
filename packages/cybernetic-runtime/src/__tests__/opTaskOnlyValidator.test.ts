import { describe, expect, it, vi } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import {
  EVAL_PLANE_TASK_ERROR,
  OP_TASK_ONLY_AGENT_TOOL_ERROR,
  PLAN_TASK_ERROR,
  validateAgentOpTaskOnlyTools,
  validateSkillEvalPlaneSeparation,
  validateSkillPlanSeparation,
} from '../scheduling/opTaskOnlyValidator.js';
import { ensureCurrentSkillValidity } from '../skillValidity/skillValidity.js';
import * as schemas from '@aflow/schemas';

function agentTask(toolIds: string[]): WorkflowTask {
  return {
    taskId: 'runner',
    name: 'Runner',
    type: 'agent',
    goal: 'Run',
    dependsOn: [],
    context: {
      strategy: 'static',
      tools: toolIds,
    },
  };
}

describe('validateAgentOpTaskOnlyTools', () => {
  it('throws teaching error when an agent task includes an opTaskOnly tool', () => {
    vi.spyOn(schemas, 'getOperation').mockImplementation((id: string) => {
      if (id === 'test.op.submit') {
        return {
          operationId: 'test.op.submit',
          opTaskOnly: true,
        } as ReturnType<typeof schemas.getOperation>;
      }
      return undefined;
    });

    const message = validateAgentOpTaskOnlyTools([
      agentTask(['memory.store.get', 'test.op.submit']),
    ]);
    expect(message).toBe(OP_TASK_ONLY_AGENT_TOOL_ERROR.replace('{toolId}', 'test.op.submit'));

    vi.restoreAllMocks();
  });

  it('rejects an opTaskOnly tool declared in the promotable ceiling', () => {
    vi.spyOn(schemas, 'getOperation').mockImplementation((id: string) => {
      if (id === 'test.op.submit') {
        return {
          operationId: 'test.op.submit',
          opTaskOnly: true,
        } as ReturnType<typeof schemas.getOperation>;
      }
      return undefined;
    });

    const task: WorkflowTask = {
      taskId: 'runner',
      name: 'Runner',
      type: 'agent',
      goal: 'Run',
      dependsOn: [],
      context: {
        strategy: 'static',
        capabilities: { operations: [], promotable: { operations: ['test.op.submit'] } },
      },
    } as unknown as WorkflowTask;
    expect(validateAgentOpTaskOnlyTools([task])).toBe(
      OP_TASK_ONLY_AGENT_TOOL_ERROR.replace('{toolId}', 'test.op.submit'),
    );

    vi.restoreAllMocks();
  });

  it('passes when no agent task references opTaskOnly tools', () => {
    vi.spyOn(schemas, 'getOperation').mockImplementation((id: string) => {
      if (id === 'memory.store.get') {
        return {
          operationId: 'memory.store.get',
          opTaskOnly: false,
        } as ReturnType<typeof schemas.getOperation>;
      }
      return undefined;
    });

    expect(validateAgentOpTaskOnlyTools([agentTask(['memory.store.get'])])).toBeNull();

    vi.restoreAllMocks();
  });
});

describe('validateSkillEvalPlaneSeparation (Plan 269 D7 — the subject must not see the ruler)', () => {
  function opTask(operation: string): WorkflowTask {
    return {
      taskId: 'measure',
      name: 'Measure',
      type: 'operation',
      goal: 'Measure',
      dependsOn: [],
      operation,
    } as unknown as WorkflowTask;
  }

  it('rejects an agent task whose tool surface references an eval.* op', () => {
    const message = validateSkillEvalPlaneSeparation([agentTask(['eval.dataset.get'])]);
    expect(message).toBe(EVAL_PLANE_TASK_ERROR.replace('{opId}', 'eval.dataset.get'));
  });

  it('rejects an operation task calling an eval.* op — even an unregistered one (fail closed)', () => {
    expect(validateSkillEvalPlaneSeparation([opTask('eval.case.promote')])).toBe(
      EVAL_PLANE_TASK_ERROR.replace('{opId}', 'eval.case.promote'),
    );
    expect(validateSkillEvalPlaneSeparation([opTask('eval.batch.run')])).toBe(
      EVAL_PLANE_TASK_ERROR.replace('{opId}', 'eval.batch.run'),
    );
  });

  it('rejects agent capabilities.operations grants too', () => {
    const task: WorkflowTask = {
      taskId: 'runner',
      name: 'Runner',
      type: 'agent',
      goal: 'Run',
      dependsOn: [],
      context: {
        strategy: 'static',
        capabilities: { operations: ['eval.dataset.list'] },
      },
    } as unknown as WorkflowTask;
    expect(validateSkillEvalPlaneSeparation([task])).toBe(
      EVAL_PLANE_TASK_ERROR.replace('{opId}', 'eval.dataset.list'),
    );
  });

  it('rejects the promotable ceiling — a promotable op is one catalog.tool.promote away from live', () => {
    const task: WorkflowTask = {
      taskId: 'runner',
      name: 'Runner',
      type: 'agent',
      goal: 'Run',
      dependsOn: [],
      context: {
        strategy: 'static',
        capabilities: { operations: [], promotable: { operations: ['eval.dataset.get'] } },
      },
    } as unknown as WorkflowTask;
    expect(validateSkillEvalPlaneSeparation([task])).toBe(
      EVAL_PLANE_TASK_ERROR.replace('{opId}', 'eval.dataset.get'),
    );
  });

  it('passes non-eval surfaces untouched', () => {
    expect(
      validateSkillEvalPlaneSeparation([agentTask(['memory.store.get', 'workflow.ledger.get'])]),
    ).toBeNull();
  });

  it('is enforced on the read-side validity recompute — the run-start gate', () => {
    const validity = ensureCurrentSkillValidity({
      tasks: [agentTask(['eval.dataset.get'])],
    });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics.some((d) => d.code === 'skill_references_eval_plane_op')).toBe(
      true,
    );
  });
});

describe('validateSkillPlanSeparation (Plan 322 D3 — a run never rewrites the plan it serves)', () => {
  function opTask(operation: string): WorkflowTask {
    return {
      taskId: 'record',
      name: 'Record',
      type: 'operation',
      goal: 'Record',
      dependsOn: [],
      operation,
    } as unknown as WorkflowTask;
  }

  function grantTask(capabilities: Record<string, unknown>): WorkflowTask {
    return {
      taskId: 'runner',
      name: 'Runner',
      type: 'agent',
      goal: 'Run',
      dependsOn: [],
      context: { strategy: 'static', capabilities },
    } as unknown as WorkflowTask;
  }

  it('refuses a Runner tool surface that references plan.node.update', () => {
    expect(validateSkillPlanSeparation([agentTask(['plan.node.update'])])).toBe(
      PLAN_TASK_ERROR.replace('{opId}', 'plan.node.update'),
    );
  });

  it('refuses reads too, and an operation id not registered yet (fail closed)', () => {
    expect(validateSkillPlanSeparation([opTask('plan.node.get')])).toBe(
      PLAN_TASK_ERROR.replace('{opId}', 'plan.node.get'),
    );
    expect(validateSkillPlanSeparation([opTask('plan.node.link')])).toBe(
      PLAN_TASK_ERROR.replace('{opId}', 'plan.node.link'),
    );
  });

  it('refuses a capability grant and the promotable ceiling', () => {
    expect(validateSkillPlanSeparation([grantTask({ operations: ['plan.node.create'] })])).toBe(
      PLAN_TASK_ERROR.replace('{opId}', 'plan.node.create'),
    );
    expect(
      validateSkillPlanSeparation([
        grantTask({ operations: [], promotable: { operations: ['plan.node.list'] } }),
      ]),
    ).toBe(PLAN_TASK_ERROR.replace('{opId}', 'plan.node.list'));
  });

  it('passes surfaces with no plan operation', () => {
    expect(
      validateSkillPlanSeparation([agentTask(['memory.store.get', 'workflow.ledger.get'])]),
    ).toBeNull();
  });

  it('is enforced on the read-side validity recompute — the run-start gate', () => {
    const validity = ensureCurrentSkillValidity({ tasks: [agentTask(['plan.node.update'])] });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics.some((d) => d.code === 'skill_references_plan_op')).toBe(true);
  });
});
