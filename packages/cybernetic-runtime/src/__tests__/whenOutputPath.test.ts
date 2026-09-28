import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph } from '../scheduling/graphValidation.js';

const decide: WorkflowTask = {
  taskId: 'triage',
  name: 'Triage',
  goal: 'Run ai.decision.decide.',
  type: 'operation',
  operation: 'ai.decision.decide',
  inputs: {
    state: 'Charged twice.',
    questions: { team: { type: 'choice', options: { billing: null, technical: null } } },
  },
};

function readerOf(expression: string): WorkflowTask {
  return {
    taskId: 'billing',
    name: 'Billing',
    goal: 'Handle billing.',
    dependsOn: ['triage'],
    when: { expression, onMissingRef: 'skip' },
  };
}

function pathErrors(tasks: WorkflowTask[]) {
  return validateWorkflowGraph(tasks).filter((e) => e.kind === 'when_output_path_unknown');
}

describe('when output paths are checked against the producer’s output', () => {
  it('accepts a path the operation’s output has, through a record key and a union', () => {
    expect(
      pathErrors([decide, readerOf("tasks.triage.output.answers.team.value == 'billing'")]),
    ).toEqual([]);
    expect(
      pathErrors([decide, readerOf('tasks.triage.output.answers.team.decided == false')]),
    ).toEqual([]);
  });

  it('refuses a path the operation’s output does not have, naming the fields there', () => {
    const errors = pathErrors([
      decide,
      readerOf("tasks.triage.output.answers.team.valeu == 'billing'"),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.taskIds).toEqual(['billing', 'triage']);
    expect(errors[0]!.detail).toContain('answers.team.valeu');
    expect(errors[0]!.detail).toContain('value');
  });

  it('refuses a missing top-level field', () => {
    expect(
      pathErrors([decide, readerOf("tasks.triage.output.decision == 'billing'")]),
    ).toHaveLength(1);
  });

  it('reads a projected task through its output contract', () => {
    const projected: WorkflowTask = {
      ...decide,
      outputProjection: { team: { path: 'answers.team.value' } },
      outputContract: {
        schema: {
          type: 'object',
          properties: { team: { type: 'string' } },
          required: ['team'],
          additionalProperties: false,
        },
      },
    };
    expect(pathErrors([projected, readerOf("tasks.triage.output.team == 'billing'")])).toEqual([]);
    expect(
      pathErrors([projected, readerOf("tasks.triage.output.answers.team.value == 'billing'")]),
    ).toHaveLength(1);
  });

  it('leaves a task with no known output shape alone', () => {
    const agent: WorkflowTask = { taskId: 'triage', name: 'Triage', goal: 'Decide.' };
    expect(pathErrors([agent, readerOf('tasks.triage.output.anything.at.all == 1')])).toEqual([]);
  });
});
