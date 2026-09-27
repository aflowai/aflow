import { describe, expect, it } from 'vitest';
import { workflowWhenView } from '../workflow/task.js';

describe('workflowWhenView', () => {
  it('projects a single expression with the tasks. prefix stripped', () => {
    expect(
      workflowWhenView({
        expression: "tasks.plan-approve.output.decision == 'approved'",
        onMissingRef: 'skip',
      }),
    ).toEqual({
      mode: 'single',
      clauses: ["plan-approve.output.decision == 'approved'"],
      onMissingRef: 'skip',
    });
  });

  it('projects allOf / anyOf combinators', () => {
    expect(
      workflowWhenView({
        allOf: [
          "tasks.plan-approve.output.decision == 'approved'",
          "tasks.implement.output.status == 'succeeded'",
        ],
        onMissingRef: 'skip',
      }),
    ).toEqual({
      mode: 'all',
      clauses: [
        "plan-approve.output.decision == 'approved'",
        "implement.output.status == 'succeeded'",
      ],
      onMissingRef: 'skip',
    });
    expect(
      workflowWhenView({
        anyOf: ["tasks.a.status == 'succeeded'", "tasks.b.status == 'succeeded'"],
        onMissingRef: 'error',
      }),
    ).toEqual({
      mode: 'any',
      clauses: ["a.status == 'succeeded'", "b.status == 'succeeded'"],
      onMissingRef: 'error',
    });
  });

  it('strips only the namespace prefix, never status/output segments', () => {
    const view = workflowWhenView({
      expression: "tasks.check.output.tasks == 'done'",
      onMissingRef: 'skip',
    });
    expect(view.clauses).toEqual(["check.output.tasks == 'done'"]);
  });
});
