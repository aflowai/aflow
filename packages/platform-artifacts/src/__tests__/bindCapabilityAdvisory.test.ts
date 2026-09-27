import { describe, it, expect } from 'vitest';
import { WorkflowRunResultAdvisorySchema, type WorkflowTask } from '@aflow/schemas';
import { validateWorkflowGraph, validateWhenExpression } from '@aflow/cybernetic-runtime';
import { BIND_CAPABILITY_WORKFLOW } from '../skillBundles.js';

const wf = BIND_CAPABILITY_WORKFLOW as unknown as {
  output?: { advisory?: string };
  stateVariables: Array<{ variableId: string }>;
  tasks: Array<Record<string, unknown>>;
};

function task(taskId: string): Record<string, unknown> {
  const t = wf.tasks.find((x) => x['taskId'] === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  return t;
}

describe('bind-capability advisory wiring', () => {
  it('declares output.advisory pointing at a real state variable', () => {
    expect(wf.output?.advisory).toBe('advisory');
    expect(wf.stateVariables.some((v) => v.variableId === 'advisory')).toBe(true);
  });

  it('elicit-target promotes its advisory output into the advisory state var', () => {
    const promos = task('elicit-target')['promoteOutputs'] as Array<Record<string, unknown>>;
    expect(promos).toContainEqual({ kind: 'output_path', path: 'advisory', toState: 'advisory' });
  });

  it('draft-definition and propose-binding are gated on proceedWithApiChange', () => {
    for (const id of ['draft-definition', 'propose-binding']) {
      const when = task(id)['when'] as { expression?: string; onMissingRef?: string } | undefined;
      expect(when?.expression).toBe('tasks.elicit-target.output.proceedWithApiChange == true');
      expect(when?.onMissingRef).toBe('skip');
    }
  });

  it('the gating when-expressions are valid against the task-output namespace', () => {
    for (const id of ['draft-definition', 'propose-binding']) {
      const when = task(id)['when'] as { expression: string };
      expect(validateWhenExpression(when.expression)).toBeNull();
    }
  });

  it('the workflow graph is valid with the advisory branch wired', () => {
    const errors = validateWorkflowGraph(
      wf.tasks as unknown as WorkflowTask[],
      wf.stateVariables as unknown as Parameters<typeof validateWorkflowGraph>[1],
    );
    expect(errors).toEqual([]);
  });

  it('the advisory schema accepts a fix-skill recommendation with a suggestedCall', () => {
    const parsed = WorkflowRunResultAdvisorySchema.safeParse({
      recommendation: 'add_direct_url_binding',
      rationale:
        'The Kaggle definition is correct; submit should PUT to the createUrl via a direct-URL binding, not a new endpoint.',
      affectedEndpoints: ['request_submission_upload'],
      suggestedCall: { op: 'workflow.manage.patch', args: { workflowSlug: 'kaggle-x' } },
    });
    expect(parsed.success).toBe(true);
  });

  it('the advisory schema accepts the author_endpoint_schema recommendation', () => {
    const parsed = WorkflowRunResultAdvisorySchema.safeParse({
      recommendation: 'author_endpoint_schema',
      rationale:
        'request_submission_upload exists but its body schema omits the required fields; author the typed body schema on the endpoint instead of patching the task.',
      affectedEndpoints: ['request_submission_upload'],
      suggestedCall: { op: 'bind-capability', args: {} },
    });
    expect(parsed.success).toBe(true);
  });
});
