import { describe, expect, it } from 'vitest';
import { WorkflowAssemblyInputSchema } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { assembleWorkflow } from '../assembleWorkflow.js';

const agent = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: 'agent',
  kind: 'transformer',
  taskId,
  goal: `Handle ${taskId}.`,
  ...extra,
});

function assemble(routes?: unknown) {
  return assembleWorkflow(
    WorkflowAssemblyInputSchema.parse({
      intent: {
        intent: 'Route support tickets.',
        iterationModel: 'process',
        requiredCapabilities: [],
        requiredDataSources: [],
        taskShapeHints: [],
        pauseForUser: { needed: false },
      },
      surface: {
        integrations: [],
        operations: ['ai.decision.decide'],
        policies: { compute: false },
        bindableButUnbound: [],
      },
      draft: {
        slug: 'ticket-triage',
        name: 'Ticket Triage',
        description: 'Route support tickets.',
        goal: 'Route each ticket to the team that owns it.',
        outcomes: [
          { id: 'routed', name: 'Routed', evaluator: { type: 'manual', instruction: 'Routed.' } },
        ],
        tasks: [
          agent('read', {
            produces: [{ key: 'ticket', shape: { type: 'string' }, semantics: 'data' }],
          }),
          {
            type: 'decision',
            taskId: 'triage',
            consumes: [{ taskId: 'read', outputKey: 'ticket', bindAs: 'ticket' }],
            questions: {
              team: {
                type: 'choice',
                options: { billing: 'Payments', technical: 'Bugs' },
                minConfidence: 0.7,
              },
            },
            routes: routes ?? [
              { question: 'team', equals: 'billing', to: ['billing'] },
              { question: 'team', equals: 'technical', to: ['technical'] },
            ],
            onUndecided: ['escalate'],
          },
          agent('billing'),
          agent('technical'),
          agent('escalate'),
        ],
      },
    }),
  );
}

describe('assembling a draft with a decision task', () => {
  it('produces a workflow that is valid as a skill', () => {
    const out = assemble();
    const { validity } = materializeAndValidateSkillConfig({
      tasks: out.workflow.tasks,
      stateVariables: out.workflow.stateVariables,
      output: out.workflow.output,
      mode: out.workflow.mode,
    });
    expect(validity.status).toBe('valid');
  });

  it('runs the decision as an operation task over the consumed output', () => {
    const triage = assemble().workflow.tasks.find((t) => t.taskId === 'triage')!;
    expect(triage).toMatchObject({
      type: 'operation',
      operation: 'ai.decision.decide',
      inputBindings: { ticket: { kind: 'task_output', taskId: 'read', path: 'ticket' } },
      inputTemplate: { state: { ticket: { $bind: 'ticket' } } },
      dependsOn: ['read'],
    });
  });

  it('guards each routed task with its route and the fallback with the abstention', () => {
    const byId = new Map(assemble().workflow.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('billing')?.when).toEqual({
      allOf: [
        "tasks.triage.output.answers.team.value == 'billing'",
        'tasks.triage.output.answers.team.decided == true',
      ],
      onMissingRef: 'skip',
    });
    expect(byId.get('escalate')?.when).toEqual({
      expression: 'tasks.triage.output.answers.team.decided == false',
      onMissingRef: 'skip',
    });
    expect(byId.get('escalate')?.dependsOn).toEqual(['triage']);
  });
});
