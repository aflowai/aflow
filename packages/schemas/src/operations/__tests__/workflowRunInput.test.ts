/**
 * Tests for the declared run-input contract field (declaration only — no
 * enforcement is wired yet).
 *
 * Focus:
 *   - `runInputs` defaults to [] when omitted.
 *   - A valid declaration parses and `required` defaults to true.
 *   - A bad `id` (not a safe identifier) is rejected.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowRunInputSchema, WorkflowPutInputSchema } from '../workflow.js';

const baselinePut = {
  slug: 'my-workflow',
  name: 'My Workflow',
  mode: 'optimization' as const,
  outcomes: [
    {
      id: 'outcome-1',
      name: 'Pass Threshold',
      evaluator: { type: 'threshold', metric: 'score', operator: 'gte', target: 0.9 },
    },
  ],
  tasks: [
    {
      taskId: 'task-1',
      type: 'operation' as const,
      name: 'Describe repo',
      goal: 'Resolve the repo binding to its public coordinates.',
      operation: 'code.repo.describe',
    },
  ],
};

describe('WorkflowRunInputSchema', () => {
  it('accepts a valid declaration and defaults required to true', () => {
    const parsed = WorkflowRunInputSchema.parse({
      id: 'repo',
      description: 'The repo coordinate to act on.',
      schema: { type: 'string' },
    });
    expect(parsed.id).toBe('repo');
    expect(parsed.required).toBe(true);
    expect(parsed.schema).toEqual({ type: 'string' });
  });

  it('honors an explicit required: false', () => {
    const parsed = WorkflowRunInputSchema.parse({ id: 'maxTurns', required: false });
    expect(parsed.required).toBe(false);
  });

  it('rejects an id that is not a safe identifier', () => {
    expect(() => WorkflowRunInputSchema.parse({ id: '1bad' })).toThrow();
    expect(() => WorkflowRunInputSchema.parse({ id: 'has-hyphen' })).toThrow();
    expect(() => WorkflowRunInputSchema.parse({ id: '' })).toThrow();
  });
});

describe('WorkflowPutInputSchema.runInputs', () => {
  it('defaults runInputs to [] when omitted', () => {
    const parsed = WorkflowPutInputSchema.parse(baselinePut);
    expect(parsed.runInputs).toEqual([]);
  });

  it('accepts a declared runInputs array', () => {
    const parsed = WorkflowPutInputSchema.parse({
      ...baselinePut,
      runInputs: [{ id: 'repo', required: true }],
    });
    expect(parsed.runInputs).toHaveLength(1);
    expect(parsed.runInputs[0]?.id).toBe('repo');
  });
});
