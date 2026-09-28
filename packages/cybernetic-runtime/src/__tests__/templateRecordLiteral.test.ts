import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph } from '../scheduling/graphValidation.js';

function decide(questions: Record<string, unknown>): WorkflowTask {
  return {
    taskId: 'triage',
    name: 'Triage',
    goal: 'Run ai.decision.decide.',
    type: 'operation',
    operation: 'ai.decision.decide',
    inputBindings: { ticket: { kind: 'run_input', path: 'ticket' } },
    inputTemplate: { state: { ticket: { $bind: 'ticket' } }, questions },
  };
}

const incompatible = (task: WorkflowTask) =>
  validateWorkflowGraph([task]).filter((e) => e.kind === 'op_input_incompatible');

describe('a literal at a record-shaped op position is validated whole', () => {
  it('accepts well-formed questions', () => {
    expect(
      incompatible(
        decide({
          team: { type: 'choice', options: { billing: null, technical: null } },
          refund_requested: { type: 'yes_no', instructions: 'Asks for a refund' },
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a question of a type the operation does not have', () => {
    const errors = incompatible(
      decide({ refund_requested: { type: 'boolean', instructions: 'Asks for a refund' } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('questions');
  });

  it('refuses a question name the output path cannot carry', () => {
    expect(
      incompatible(
        decide({ refundRequested: { type: 'yes_no', instructions: 'Asks for a refund' } }),
      ),
    ).toHaveLength(1);
  });
});
