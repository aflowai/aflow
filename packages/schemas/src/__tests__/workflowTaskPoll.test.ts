import { describe, expect, it } from 'vitest';
import {
  POLL_RESERVED_OUTPUT_KEY,
  predicateCombinator,
  predicateExpressions,
  predicateKey,
  WorkflowTaskSchema,
} from '../index.js';

const BASE = { taskId: 'poll-lb', name: 'Poll LB', goal: 'poll the leaderboard' };

const VALID_POLL = {
  intervalMs: 60_000,
  maxCycles: 5,
  until: { anyOf: ["output.status == 'COMPLETE'", "output.status == 'ERROR'"] },
};

describe('WorkflowTaskSchema.poll (Plan 194 §4.2)', () => {
  it('accepts poll on an operation task and defaults onExhausted to complete', () => {
    const parsed = WorkflowTaskSchema.parse({
      ...BASE,
      type: 'operation',
      operation: 'mcp.tool.call',
      poll: VALID_POLL,
    });
    expect(parsed.poll?.onExhausted).toBe('complete');
    expect(parsed.poll?.maxCycles).toBe(5);
  });

  it('rejects poll on an agent task', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'agent',
      poll: VALID_POLL,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'poll')).toBe(true);
    }
  });

  it('rejects poll on a human task', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'human',
      pauseInstruction: 'approve',
      poll: VALID_POLL,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'poll')).toBe(true);
    }
  });

  it('rejects intervalMs below the platform snooze minimum', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'operation',
      operation: 'mcp.tool.call',
      poll: { ...VALID_POLL, intervalMs: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'poll.intervalMs')).toBe(true);
    }
  });

  it('caps maxCycles at 20', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'operation',
      operation: 'mcp.tool.call',
      poll: { ...VALID_POLL, maxCycles: 21 },
    });
    expect(result.success).toBe(false);
  });

  it('exports the reserved output key', () => {
    expect(POLL_RESERVED_OUTPUT_KEY).toBe('_poll');
  });
});

describe('WorkflowTaskSchema.when union (Plan 194 §4.6)', () => {
  function opTask(when: unknown) {
    return { ...BASE, type: 'operation', operation: 'mcp.tool.call', when };
  }

  it('accepts the single-expression variant with defaulted onMissingRef', () => {
    const parsed = WorkflowTaskSchema.parse(
      opTask({ expression: 'tasks.execute.output.submit == true' }),
    );
    expect(parsed.when).toEqual({
      expression: 'tasks.execute.output.submit == true',
      onMissingRef: 'skip',
    });
  });

  it('accepts anyOf and allOf variants', () => {
    const anyOf = WorkflowTaskSchema.parse(
      opTask({ anyOf: ["tasks.a.status == 'succeeded'", "tasks.b.status == 'succeeded'"] }),
    );
    expect(anyOf.when && predicateCombinator(anyOf.when)).toBe('anyOf');
    const allOf = WorkflowTaskSchema.parse(
      opTask({ allOf: ['tasks.a.output.x == true'], onMissingRef: 'error' }),
    );
    expect(allOf.when && predicateCombinator(allOf.when)).toBe('allOf');
    expect(allOf.when?.onMissingRef).toBe('error');
  });

  it('rejects mixing combinators in one predicate', () => {
    const result = WorkflowTaskSchema.safeParse(
      opTask({ expression: 'tasks.a.output.x == true', anyOf: ['tasks.a.output.y == true'] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an empty combinator list', () => {
    expect(WorkflowTaskSchema.safeParse(opTask({ anyOf: [] })).success).toBe(false);
  });

  it('predicate helpers expose expressions, combinator, and a canonical key', () => {
    const single = { expression: 'tasks.a.output.x == true' };
    const combo = { anyOf: ['a == 1', 'b == 2'] };
    expect(predicateExpressions(single)).toEqual(['tasks.a.output.x == true']);
    expect(predicateExpressions(combo)).toEqual(['a == 1', 'b == 2']);
    expect(predicateKey(single)).toBe('expression:tasks.a.output.x == true');
    expect(predicateKey(combo)).toBe('anyOf:a == 1 || b == 2');
    expect(predicateKey({ anyOf: ['a == 1', 'b == 2'] })).toBe(predicateKey(combo));
    expect(predicateKey({ allOf: ['a == 1', 'b == 2'] })).not.toBe(predicateKey(combo));
  });
});
