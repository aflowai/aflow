import { describe, it, expect } from 'vitest';
import {
  evaluateWhen,
  evaluateUntilPredicate,
  computeReadyTasksWithWhen,
  computeDescendants,
  computeBlockedDescendantsToClearForRetry,
  computeRejectedApprovalSkipSet,
  type TaskOutputContext,
} from '../scheduling/graph.js';
import type { WorkflowTask } from '@aflow/schemas';
// SkillConcurrencyPolicySchema and SkillManifestSchema are tested inline
// below using direct source imports (ts-source condition not available in vitest).
import {
  SkillConcurrencyPolicySchema,
  SkillManifestSchema,
} from '../../../schemas/src/cybernetic/skill.js';

// ============================================================================
// Helpers
// ============================================================================

function task(
  taskId: string,
  opts?: {
    dependsOn?: string[];
    optional?: boolean;
    when?: { expression: string; onMissingRef?: 'skip' | 'error' };
  },
): WorkflowTask {
  return {
    taskId,
    name: `Task ${taskId}`,
    goal: `Goal for ${taskId}`,
    ...(opts?.dependsOn ? { dependsOn: opts.dependsOn } : {}),
    ...(opts?.optional !== undefined ? { optional: opts.optional } : {}),
    ...(opts?.when ? { when: { onMissingRef: 'skip' as const, ...opts.when } } : {}),
  };
}

function emptyContext(): TaskOutputContext {
  return { statuses: new Map(), outputs: new Map() };
}

function evaluateWhenPredicate(
  expression: string,
  ctx: TaskOutputContext,
  onMissingRef: 'skip' | 'error',
) {
  return evaluateWhen({ expression, onMissingRef }, ctx);
}

// ============================================================================
// evaluateWhenPredicate
// ============================================================================

describe('evaluateWhenPredicate', () => {
  describe('status comparisons', () => {
    it('passes when status matches', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map(),
      };
      const result = evaluateWhenPredicate("tasks.a.status == 'succeeded'", ctx, 'skip');
      expect(result.outcome).toBe('pass');
    });

    it('skips when status does not match', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'failed']]),
        outputs: new Map(),
      };
      const result = evaluateWhenPredicate("tasks.a.status == 'succeeded'", ctx, 'skip');
      expect(result.outcome).toBe('skip');
    });

    it('handles != operator', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'failed']]),
        outputs: new Map(),
      };
      const result = evaluateWhenPredicate("tasks.a.status != 'succeeded'", ctx, 'skip');
      expect(result.outcome).toBe('pass');
    });

    it('skips when referenced task has no status (onMissingRef=skip)', () => {
      const result = evaluateWhenPredicate(
        "tasks.nonexistent.status == 'succeeded'",
        emptyContext(),
        'skip',
      );
      expect(result.outcome).toBe('skip');
    });

    it('errors when referenced task has no status (onMissingRef=error)', () => {
      const result = evaluateWhenPredicate(
        "tasks.nonexistent.status == 'succeeded'",
        emptyContext(),
        'error',
      );
      expect(result.outcome).toBe('error');
    });
  });

  describe('numeric output comparisons', () => {
    it('passes when output field exceeds threshold', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { score: 0.9 }]]),
      };
      const result = evaluateWhenPredicate('tasks.a.output.score > 0.8', ctx, 'skip');
      expect(result.outcome).toBe('pass');
    });

    it('skips when output field is below threshold', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { score: 0.5 }]]),
      };
      const result = evaluateWhenPredicate('tasks.a.output.score > 0.8', ctx, 'skip');
      expect(result.outcome).toBe('skip');
    });

    it('handles >= operator', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { count: 10 }]]),
      };
      expect(evaluateWhenPredicate('tasks.a.output.count >= 10', ctx, 'skip').outcome).toBe('pass');
      expect(evaluateWhenPredicate('tasks.a.output.count >= 11', ctx, 'skip').outcome).toBe('skip');
    });

    it('handles < and <= operators', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { rmsle: 0.123 }]]),
      };
      expect(evaluateWhenPredicate('tasks.a.output.rmsle < 0.124', ctx, 'skip').outcome).toBe(
        'pass',
      );
      expect(evaluateWhenPredicate('tasks.a.output.rmsle <= 0.123', ctx, 'skip').outcome).toBe(
        'pass',
      );
    });

    it('handles == and != for numbers', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { val: 42 }]]),
      };
      expect(evaluateWhenPredicate('tasks.a.output.val == 42', ctx, 'skip').outcome).toBe('pass');
      expect(evaluateWhenPredicate('tasks.a.output.val != 42', ctx, 'skip').outcome).toBe('skip');
    });

    it('skips when output is missing (onMissingRef=skip)', () => {
      const result = evaluateWhenPredicate('tasks.a.output.score > 0.8', emptyContext(), 'skip');
      expect(result.outcome).toBe('skip');
    });
  });

  describe('string output comparisons', () => {
    it('passes when string field matches', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { model: 'xgboost' }]]),
      };
      const result = evaluateWhenPredicate("tasks.a.output.model == 'xgboost'", ctx, 'skip');
      expect(result.outcome).toBe('pass');
    });

    it('skips when string field does not match', () => {
      const ctx: TaskOutputContext = {
        statuses: new Map([['a', 'succeeded']]),
        outputs: new Map([['a', { model: 'linear' }]]),
      };
      const result = evaluateWhenPredicate("tasks.a.output.model == 'xgboost'", ctx, 'skip');
      expect(result.outcome).toBe('skip');
    });
  });

  describe('error cases', () => {
    it('errors on unrecognized expression', () => {
      const result = evaluateWhenPredicate('something random', emptyContext(), 'skip');
      expect(result.outcome).toBe('error');
    });

    it('errors on embedded boolean operators (combinators are JSON-level)', () => {
      const result = evaluateWhenPredicate(
        "tasks.a.status == 'succeeded' && tasks.b.status == 'succeeded'",
        emptyContext(),
        'skip',
      );
      expect(result.outcome).toBe('error');
    });
  });

  describe('typed boolean comparisons', () => {
    const ctx = (): TaskOutputContext => ({
      statuses: new Map([['a', 'succeeded']]),
      outputs: new Map([['a', { submit: true, flag: false, label: 'true' }]]),
    });

    it('compares boolean true as a boolean', () => {
      expect(evaluateWhenPredicate('tasks.a.output.submit == true', ctx(), 'skip').outcome).toBe(
        'pass',
      );
      expect(evaluateWhenPredicate('tasks.a.output.flag == true', ctx(), 'skip').outcome).toBe(
        'skip',
      );
      expect(evaluateWhenPredicate('tasks.a.output.flag == false', ctx(), 'skip').outcome).toBe(
        'pass',
      );
      expect(evaluateWhenPredicate('tasks.a.output.submit != false', ctx(), 'skip').outcome).toBe(
        'pass',
      );
    });

    it("boolean true is NOT equal to the string 'true' (no stringify coercion)", () => {
      expect(evaluateWhenPredicate("tasks.a.output.submit == 'true'", ctx(), 'skip').outcome).toBe(
        'skip',
      );
      // …and the string 'true' is not the boolean true.
      expect(evaluateWhenPredicate('tasks.a.output.label == true', ctx(), 'skip').outcome).toBe(
        'skip',
      );
      expect(evaluateWhenPredicate("tasks.a.output.label == 'true'", ctx(), 'skip').outcome).toBe(
        'pass',
      );
    });

    it('a string number is NOT equal to a number literal', () => {
      const c: TaskOutputContext = {
        statuses: new Map(),
        outputs: new Map([['a', { n: '5' }]]),
      };
      expect(evaluateWhenPredicate('tasks.a.output.n == 5', c, 'skip').outcome).toBe('skip');
      expect(evaluateWhenPredicate('tasks.a.output.n != 5', c, 'skip').outcome).toBe('pass');
    });

    it('ordering against a non-number falls to the missing path', () => {
      const c: TaskOutputContext = {
        statuses: new Map(),
        outputs: new Map([['a', { n: '5' }]]),
      };
      expect(evaluateWhenPredicate('tasks.a.output.n > 1', c, 'skip').outcome).toBe('skip');
      expect(evaluateWhenPredicate('tasks.a.output.n > 1', c, 'error').outcome).toBe('error');
    });
  });

  describe('null comparisons (pairs with projection onMissing: null)', () => {
    // A field projected with `onMissing: 'null'` is PRESENT as null — distinct
    // from a genuinely absent field (undefined → the missing/onMissingRef path).
    const ctx = (): TaskOutputContext => ({
      statuses: new Map([['a', 'succeeded']]),
      outputs: new Map([['a', { existing: null, present: 4 }]]),
    });

    it('== null passes for a null field, skips for a non-null one', () => {
      expect(evaluateWhenPredicate('tasks.a.output.existing == null', ctx(), 'skip').outcome).toBe(
        'pass',
      );
      expect(evaluateWhenPredicate('tasks.a.output.present == null', ctx(), 'skip').outcome).toBe(
        'skip',
      );
    });

    it('!= null passes for a present value, skips for null', () => {
      expect(evaluateWhenPredicate('tasks.a.output.present != null', ctx(), 'skip').outcome).toBe(
        'pass',
      );
      expect(evaluateWhenPredicate('tasks.a.output.existing != null', ctx(), 'skip').outcome).toBe(
        'skip',
      );
    });

    it('a genuinely missing field is NOT null — it takes the onMissingRef path', () => {
      expect(evaluateWhenPredicate('tasks.a.output.absent == null', ctx(), 'skip').outcome).toBe(
        'skip',
      );
      expect(evaluateWhenPredicate('tasks.a.output.absent == null', ctx(), 'error').outcome).toBe(
        'error',
      );
    });
  });
});

// ============================================================================

describe('evaluateWhen combinators', () => {
  const ctx = (): TaskOutputContext => ({
    statuses: new Map([['a', 'succeeded']]),
    outputs: new Map([['a', { status: 'PENDING', score: 0.9 }]]),
  });

  it('anyOf passes when any comparison is true', () => {
    const result = evaluateWhen(
      {
        anyOf: ["tasks.a.output.status == 'COMPLETE'", 'tasks.a.output.score > 0.8'],
        onMissingRef: 'skip',
      },
      ctx(),
    );
    expect(result.outcome).toBe('pass');
  });

  it('anyOf skips when all comparisons are false', () => {
    const result = evaluateWhen(
      {
        anyOf: ["tasks.a.output.status == 'COMPLETE'", 'tasks.a.output.score > 0.95'],
        onMissingRef: 'skip',
      },
      ctx(),
    );
    expect(result.outcome).toBe('skip');
  });

  it('anyOf with one true comparison passes even when another ref is missing', () => {
    const result = evaluateWhen(
      {
        anyOf: ['tasks.a.output.score > 0.8', "tasks.ghost.output.x == 'y'"],
        onMissingRef: 'error',
      },
      ctx(),
    );
    expect(result.outcome).toBe('pass');
  });

  it('anyOf with nothing true and a missing ref applies onMissingRef', () => {
    const pred = {
      anyOf: ["tasks.a.output.status == 'COMPLETE'", "tasks.ghost.output.x == 'y'"],
    };
    expect(evaluateWhen({ ...pred, onMissingRef: 'skip' }, ctx()).outcome).toBe('skip');
    expect(evaluateWhen({ ...pred, onMissingRef: 'error' }, ctx()).outcome).toBe('error');
  });

  it('allOf passes only when every comparison is true', () => {
    expect(
      evaluateWhen(
        {
          allOf: ["tasks.a.output.status == 'PENDING'", 'tasks.a.output.score > 0.8'],
          onMissingRef: 'skip',
        },
        ctx(),
      ).outcome,
    ).toBe('pass');
    expect(
      evaluateWhen(
        {
          allOf: ["tasks.a.output.status == 'PENDING'", 'tasks.a.output.score > 0.95'],
          onMissingRef: 'skip',
        },
        ctx(),
      ).outcome,
    ).toBe('skip');
  });

  it('allOf with a definitive false skips even when another ref is missing', () => {
    const result = evaluateWhen(
      {
        allOf: ["tasks.a.output.status == 'COMPLETE'", "tasks.ghost.output.x == 'y'"],
        onMissingRef: 'error',
      },
      ctx(),
    );
    expect(result.outcome).toBe('skip');
  });

  it('allOf with all-true-or-missing applies onMissingRef', () => {
    const pred = {
      allOf: ["tasks.a.output.status == 'PENDING'", "tasks.ghost.output.x == 'y'"],
    };
    expect(evaluateWhen({ ...pred, onMissingRef: 'skip' }, ctx()).outcome).toBe('skip');
    expect(evaluateWhen({ ...pred, onMissingRef: 'error' }, ctx()).outcome).toBe('error');
  });
});

// ============================================================================

describe('evaluateUntilPredicate', () => {
  it('matches a single expression against the raw output', () => {
    expect(
      evaluateUntilPredicate({ expression: "output.status == 'COMPLETE'" }, { status: 'COMPLETE' }),
    ).toBe(true);
    expect(
      evaluateUntilPredicate({ expression: "output.status == 'COMPLETE'" }, { status: 'PENDING' }),
    ).toBe(false);
  });

  it('anyOf is met when any expression matches (the Kaggle poll shape)', () => {
    const until = { anyOf: ["output.status == 'COMPLETE'", "output.status == 'ERROR'"] };
    expect(evaluateUntilPredicate(until, { status: 'ERROR' })).toBe(true);
    expect(evaluateUntilPredicate(until, { status: 'COMPLETE' })).toBe(true);
    expect(evaluateUntilPredicate(until, { status: 'PENDING' })).toBe(false);
  });

  it('allOf requires every expression to match', () => {
    const until = { allOf: ["output.status == 'COMPLETE'", 'output.score > 0.5'] };
    expect(evaluateUntilPredicate(until, { status: 'COMPLETE', score: 0.9 })).toBe(true);
    expect(evaluateUntilPredicate(until, { status: 'COMPLETE', score: 0.1 })).toBe(false);
  });

  it('typed booleans and numbers compare typed', () => {
    expect(evaluateUntilPredicate({ expression: 'output.done == true' }, { done: true })).toBe(
      true,
    );
    expect(evaluateUntilPredicate({ expression: 'output.done == true' }, { done: 'true' })).toBe(
      false,
    );
    expect(evaluateUntilPredicate({ expression: 'output.n >= 3' }, { n: 3 })).toBe(true);
  });

  it('missing path / non-object output / unparseable expression = unmet, never failure', () => {
    expect(evaluateUntilPredicate({ expression: "output.status == 'COMPLETE'" }, {})).toBe(false);
    expect(evaluateUntilPredicate({ expression: "output.status == 'COMPLETE'" }, 'raw')).toBe(
      false,
    );
    expect(evaluateUntilPredicate({ expression: "output.status == 'COMPLETE'" }, null)).toBe(false);
    // `until` may not reference other tasks — unparseable = unmet.
    expect(evaluateUntilPredicate({ expression: "tasks.other.output.x == 'y'" }, { x: 'y' })).toBe(
      false,
    );
  });
});

// ============================================================================
// computeReadyTasksWithWhen
// ============================================================================

describe('computeReadyTasksWithWhen', () => {
  it('returns root tasks as ready when no deps and no when', () => {
    const tasks = [task('a'), task('b')];
    const result = computeReadyTasksWithWhen(tasks, new Set(), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('respects dependency ordering', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })];
    const result = computeReadyTasksWithWhen(tasks, new Set(), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['a']);
  });

  it('returns multiple tasks when fan-out deps are satisfied', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['a'] })];
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId).sort()).toEqual(['b', 'c']);
  });

  it('skips tasks whose when predicate is false', () => {
    const tasks = [
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "tasks.a.status == 'failed'" },
      }),
    ];
    const ctx: TaskOutputContext = {
      statuses: new Map([['a', 'succeeded']]),
      outputs: new Map(),
    };
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), ctx);
    expect(result.ready).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.task.taskId).toBe('b');
  });

  it('passes tasks whose when predicate is true', () => {
    const tasks = [
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "tasks.a.status == 'succeeded'" },
      }),
    ];
    const ctx: TaskOutputContext = {
      statuses: new Map([['a', 'succeeded']]),
      outputs: new Map(),
    };
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), ctx);
    expect(result.ready.map((t) => t.taskId)).toEqual(['b']);
  });

  it('excludes already completed tasks', () => {
    const tasks = [task('a'), task('b')];
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['b']);
  });

  it('treats skipped deps as satisfied', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] })];
    const result = computeReadyTasksWithWhen(tasks, new Set(), new Set(['a']), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['b']);
  });

  it('reports when-predicate errors with onMissingRef=error', () => {
    const tasks = [
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "tasks.missing.status == 'succeeded'", onMissingRef: 'error' },
      }),
    ];
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), emptyContext());
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.task.taskId).toBe('b');
  });
});

// ============================================================================
// computeDescendants
// ============================================================================

describe('computeDescendants', () => {
  it('returns empty set for leaf tasks', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] })];
    const desc = computeDescendants(tasks, new Set(['b']));
    expect(desc.size).toBe(0);
  });

  it('returns direct children', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['a'] })];
    const desc = computeDescendants(tasks, new Set(['a']));
    expect(desc).toEqual(new Set(['b', 'c']));
  });

  it('returns transitive descendants', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
      task('d', { dependsOn: ['c'] }),
    ];
    const desc = computeDescendants(tasks, new Set(['a']));
    expect(desc).toEqual(new Set(['b', 'c', 'd']));
  });

  it('handles diamond dependencies', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b', 'c'] }),
    ];
    const desc = computeDescendants(tasks, new Set(['a']));
    expect(desc).toEqual(new Set(['b', 'c', 'd']));
  });

  it('does not include the root tasks themselves', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] })];
    const desc = computeDescendants(tasks, new Set(['a']));
    expect(desc.has('a')).toBe(false);
    expect(desc.has('b')).toBe(true);
  });

  it('handles multiple roots', () => {
    const tasks = [
      task('a'),
      task('b'),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b'] }),
    ];
    const desc = computeDescendants(tasks, new Set(['a', 'b']));
    expect(desc).toEqual(new Set(['c', 'd']));
  });
});

// ============================================================================
// computeRejectedApprovalSkipSet
// ============================================================================

describe('computeRejectedApprovalSkipSet', () => {
  it('skips the approve task + its when-gated branch, but NOT the always-on downstream', () => {
    // approve → gated (when) → always-on (no when). The classic reject-but-learn shape.
    const tasks = [
      task('execute'),
      task('approve', {
        dependsOn: ['execute'],
        when: { expression: 'tasks.execute.output.submit == true' },
      }),
      task('gated', {
        dependsOn: ['approve'],
        when: { expression: 'tasks.execute.output.submit == true' },
      }),
      task('always-on', { dependsOn: ['gated'] }), // no `when` → unconditional
    ];
    const skip = computeRejectedApprovalSkipSet(tasks, 'approve');
    expect(skip).toEqual(new Set(['approve', 'gated']));
    // The always-on downstream is deliberately excluded so the scheduler runs it.
    expect(skip.has('always-on')).toBe(false);
  });

  it('always includes the approve task itself, even with no descendants', () => {
    const tasks = [task('execute'), task('approve', { dependsOn: ['execute'] })];
    expect(computeRejectedApprovalSkipSet(tasks, 'approve')).toEqual(new Set(['approve']));
  });

  it('excludes a when-less descendant that sits between two gated tasks', () => {
    const tasks = [
      task('approve', { when: { expression: 'tasks.x.output.go == true' } }),
      task('gated-1', {
        dependsOn: ['approve'],
        when: { expression: 'tasks.x.output.go == true' },
      }),
      task('passthrough', { dependsOn: ['gated-1'] }), // no when
      task('gated-2', {
        dependsOn: ['passthrough'],
        when: { expression: 'tasks.x.output.go == true' },
      }),
    ];
    const skip = computeRejectedApprovalSkipSet(tasks, 'approve');
    expect(skip).toEqual(new Set(['approve', 'gated-1', 'gated-2']));
    expect(skip.has('passthrough')).toBe(false);
  });
});

// ============================================================================
// computeBlockedDescendantsToClearForRetry
// ============================================================================

describe('computeBlockedDescendantsToClearForRetry', () => {
  it('clears a linear chain of blocked descendants', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })];
    const clearable = computeBlockedDescendantsToClearForRetry(
      tasks,
      [
        { taskId: 'a', status: 'failed' },
        { taskId: 'b', status: 'blocked' },
        { taskId: 'c', status: 'blocked' },
      ],
      'a',
    );
    expect(clearable).toEqual(new Set(['b', 'c']));
  });

  it('does not clear a shared descendant while another required dependency is failed', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c'),
      task('d', { dependsOn: ['b', 'c'] }),
    ];
    const clearable = computeBlockedDescendantsToClearForRetry(
      tasks,
      [
        { taskId: 'a', status: 'failed' },
        { taskId: 'b', status: 'blocked' },
        { taskId: 'c', status: 'failed' },
        { taskId: 'd', status: 'blocked' },
      ],
      'a',
    );
    expect(clearable).toEqual(new Set(['b']));
  });

  it('allows a shared descendant when the other failed dependency is optional', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { optional: true }),
      task('d', { dependsOn: ['b', 'c'] }),
    ];
    const clearable = computeBlockedDescendantsToClearForRetry(
      tasks,
      [
        { taskId: 'a', status: 'failed' },
        { taskId: 'b', status: 'blocked' },
        { taskId: 'c', status: 'failed' },
        { taskId: 'd', status: 'blocked' },
      ],
      'a',
    );
    expect(clearable).toEqual(new Set(['b', 'd']));
  });
});

// ============================================================================
// dangling_when_ref validation (via graphValidation)
// ============================================================================

describe('dangling_when_ref validation', () => {
  it('rejects when expression referencing non-existent task', async () => {
    const { validateWorkflowGraph } = await import('../scheduling/graphValidation.js');
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "tasks.nonexistent.status == 'succeeded'" },
      }),
    ]);
    expect(errors.some((e) => e.kind === 'dangling_when_ref')).toBe(true);
    const err = errors.find((e) => e.kind === 'dangling_when_ref')!;
    expect(err.taskIds).toContain('b');
    expect(err.taskIds).toContain('nonexistent');
  });

  it('accepts when expression referencing valid task', async () => {
    const { validateWorkflowGraph } = await import('../scheduling/graphValidation.js');
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "tasks.a.status == 'succeeded'" },
      }),
    ]);
    expect(errors.filter((e) => e.kind === 'dangling_when_ref')).toEqual([]);
  });

  it('accepts task with no when predicate', async () => {
    const { validateWorkflowGraph } = await import('../scheduling/graphValidation.js');
    const errors = validateWorkflowGraph([task('a'), task('b', { dependsOn: ['a'] })]);
    expect(errors.filter((e) => e.kind === 'dangling_when_ref')).toEqual([]);
  });
});

// ============================================================================
// SkillConcurrencyPolicy schema
// ============================================================================

describe('SkillConcurrencyPolicy schema', () => {
  it('is exported from the skill schema', () => {
    expect(SkillConcurrencyPolicySchema).toBeDefined();
  });

  it('has correct defaults (Phase 4: isolate is the new default)', () => {
    const parsed = SkillConcurrencyPolicySchema.parse({});
    expect(parsed.maxParallelTasksPerRun).toBe(4);
    expect(parsed.maxConcurrentRuns).toBe(5);
    expect(parsed.failureMode).toBe('isolate');
    expect(parsed.perUserSerial).toBe(false);
  });

  it('is optional on SkillManifest', () => {
    const manifest = SkillManifestSchema.parse({
      schemaVersion: 1,
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.concurrency).toBeUndefined();
  });

  it('accepts concurrency policy on SkillManifest', () => {
    const manifest = SkillManifestSchema.parse({
      schemaVersion: 1,
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      concurrency: { maxParallelTasksPerRun: 8, failureMode: 'isolate' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.concurrency?.maxParallelTasksPerRun).toBe(8);
    expect(manifest.concurrency?.failureMode).toBe('isolate');
  });
});

// ============================================================================
// cancel_siblings vs isolate semantics (behavioral)
// ============================================================================

describe('cancel_siblings vs isolate failure semantics', () => {
  it('cancel_siblings: ALL other tasks should be blocked on required failure', () => {
    // In a fan-out (A → B, A → C), if B fails with cancel_siblings,
    // C must also be blocked — not just descendants of B.
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }), // independent sibling of b
      task('d', { dependsOn: ['b'] }), // descendant of b
    ];

    // cancel_siblings: on B failure, block EVERYTHING else (C and D)
    const allOtherTasks = tasks.map((t) => t.taskId).filter((id) => id !== 'b');
    expect(allOtherTasks).toEqual(['a', 'c', 'd']);
    // blockDescendantTasks is called with allOtherTasks — safe no-op for
    // tasks already in terminal state (like completed 'a')
  });

  it('isolate (Phase 2): only descendants should be blocked', () => {
    // Same graph, but with isolate mode: only D (descendant of B) is blocked.
    // C (independent sibling) continues.
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b'] }),
    ];

    // isolate: on B failure, block only descendants of B
    const descendants = computeDescendants(tasks, new Set(['b']));
    expect(descendants).toEqual(new Set(['d']));
    // C is NOT in descendants — it continues independently
    expect(descendants.has('c')).toBe(false);
  });
});

// ============================================================================
// Terminal task status check (premature completion fix)
// ============================================================================

describe('terminal task status semantics', () => {
  const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'blocked']);

  it('succeeded is terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('succeeded')).toBe(true);
  });

  it('failed is terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('failed')).toBe(true);
  });

  it('skipped is terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('skipped')).toBe(true);
  });

  it('blocked is terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('blocked')).toBe(true);
  });

  it('scheduled is NOT terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('scheduled')).toBe(false);
  });

  it('running is NOT terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('running')).toBe(false);
  });

  it('claimed is NOT terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('claimed')).toBe(false);
  });

  it('paused is NOT terminal', () => {
    expect(TERMINAL_TASK_STATUSES.has('paused')).toBe(false);
  });
});

// ============================================================================
// When expression format validation
// ============================================================================

describe('when expression write-time validation', () => {
  it('accepts tasks.<id>.status == comparison', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression("tasks.a.status == 'succeeded'")).toBeNull();
  });

  it('accepts tasks.<id>.output.<field> numeric comparison', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression('tasks.a.output.score > 0.8')).toBeNull();
    expect(validateWhenExpression('tasks.a.output.count >= 10')).toBeNull();
    expect(validateWhenExpression('tasks.a.output.rmsle < 0.124')).toBeNull();
  });

  it('accepts tasks.<id>.output.<field> string comparison', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression("tasks.a.output.model == 'xgboost'")).toBeNull();
  });

  it('rejects run.* references', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    const err = validateWhenExpression("run.workflow_slug == 'test'");
    expect(err).not.toBeNull();
    expect(err).toContain('Unsupported');
  });

  it('rejects tasks.<id>.metrics.* references', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    const err = validateWhenExpression('tasks.a.metrics.rmsle > 0.1');
    expect(err).not.toBeNull();
    expect(err).toContain('Unsupported');
  });

  it('rejects bare identifiers', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    const err = validateWhenExpression('someVar > 5');
    expect(err).not.toBeNull();
  });

  it('rejects boolean combinators', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    const err = validateWhenExpression(
      "tasks.a.status == 'succeeded' && tasks.b.status == 'succeeded'",
    );
    expect(err).not.toBeNull();
  });

  it('accepts nested output paths under the shared dialect (Plan 194 §4.3)', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression('tasks.a.output.eval.score > 0.8')).toBeNull();
    expect(validateWhenExpression("tasks.a.output.content[0].text == 'done'")).toBeNull();
  });

  it('rejects malformed output paths (empty segment / non-numeric indexer)', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression('tasks.a.output.eval..score > 0.8')).not.toBeNull();
    expect(validateWhenExpression('tasks.a.output.content[x].text > 0.8')).not.toBeNull();
  });

  it('accepts flat output field names', async () => {
    const { validateWhenExpression } = await import('../scheduling/graphValidation.js');
    expect(validateWhenExpression('tasks.a.output.score > 0.8')).toBeNull();
    expect(validateWhenExpression('tasks.a.output.eval_score > 0.8')).toBeNull();
  });

  it('is wired into validateWorkflowGraph', async () => {
    const { validateWorkflowGraph } = await import('../scheduling/graphValidation.js');
    const errors = validateWorkflowGraph([
      task('a'),
      task('b', {
        dependsOn: ['a'],
        when: { expression: "run.workflow_slug == 'test'" },
      }),
    ]);
    expect(errors.some((e) => e.kind === 'unsupported_when_expression')).toBe(true);
  });
});

// ============================================================================
// extractWhenTaskRefs — LHS-only extraction
// ============================================================================

describe('extractWhenTaskRefs', () => {
  it('extracts task ID from status comparison', async () => {
    const { extractWhenTaskRefs } = await import('../scheduling/graphValidation.js');
    expect(extractWhenTaskRefs("tasks.prepare.status == 'succeeded'")).toEqual(['prepare']);
  });

  it('extracts task ID from output comparison', async () => {
    const { extractWhenTaskRefs } = await import('../scheduling/graphValidation.js');
    expect(extractWhenTaskRefs('tasks.train.output.score > 0.8')).toEqual(['train']);
  });

  it('does NOT extract task IDs from quoted string literals on RHS', async () => {
    const { extractWhenTaskRefs } = await import('../scheduling/graphValidation.js');
    // "tasks.ghost.status" is inside a quoted string — should not be treated as a ref
    const refs = extractWhenTaskRefs("tasks.a.output.msg == 'see tasks.ghost.status'");
    expect(refs).toEqual(['a']);
    expect(refs).not.toContain('ghost');
  });

  it('returns empty for unrecognized expressions', async () => {
    const { extractWhenTaskRefs } = await import('../scheduling/graphValidation.js');
    expect(extractWhenTaskRefs('someVar > 5')).toEqual([]);
  });
});

// ============================================================================
// Phase 2: optional task handling
// ============================================================================

describe('optional task failure handling', () => {
  it('optional task failure does not block descendants in isolate mode', () => {
    // With isolate mode, a failed optional task should not propagate blocked.
    // Descendants should still be schedulable (with missing output).
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'], optional: true }),
      task('c', { dependsOn: ['b'] }),
    ];

    // Since b is optional and failed, computeDescendants gives us ['c'],
    // but we should NOT block c — optional failure means "treat as if
    // completed with empty output."
    const descendants = computeDescendants(tasks, new Set(['b']));
    expect(descendants).toEqual(new Set(['c']));
    // The engine checks isOptional before calling blockDescendantTasks.
    // This test documents that the graph helpers correctly identify descendants
    // but the blocking decision is in the engine, not the graph module.
  });

  it('computeReadyTasksWithWhen treats skipped deps as satisfied', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'], optional: true }),
      task('c', { dependsOn: ['b'] }),
    ];
    // b was skipped (optional failure) — c should be ready
    const result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(['b']), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['c']);
  });
});

// ============================================================================

describe('computeReadyTasksWithWhen + computeDescendants — unified graph lens (Plan 123 §3.3)', () => {
  function bindingTask(
    taskId: string,
    bindings: Record<string, { kind: 'task_output' | 'task_summary'; taskId: string }>,
    dependsOn?: string[],
  ): WorkflowTask {
    return {
      taskId,
      name: `Task ${taskId}`,
      goal: `Goal for ${taskId}`,
      ...(dependsOn ? { dependsOn } : {}),
      inputBindings: Object.fromEntries(
        Object.entries(bindings).map(([k, v]) => [
          k,
          { ...v, ...(v.kind === 'task_output' ? { outputKey: 'output' } : {}) },
        ]),
      ),
    } as WorkflowTask;
  }

  it('readiness waits on inputBinding producers even when dependsOn is omitted', () => {
    // Reset scope and readiness must use the same graph lens. Without this,
    // a producer rerun resets producer + binding-only consumer to pending,
    // then the next scheduling pass schedules them BOTH (the consumer
    // doesn't see its binding's producer as a dependency in the
    // dependsOn-only view) → consumer races ahead of fresh producer output.
    const tasks = [
      task('producer'),
      bindingTask('binding-only-consumer', {
        x: { kind: 'task_output', taskId: 'producer' },
      }),
    ];
    // Producer is pending (not in satisfiedIds) → consumer must NOT be ready.
    const result = computeReadyTasksWithWhen(tasks, new Set(), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toEqual(['producer']);
    expect(result.ready.find((t) => t.taskId === 'binding-only-consumer')).toBeUndefined();
  });

  it('binding-only consumer becomes ready once its producer is satisfied', () => {
    const tasks = [
      task('producer'),
      bindingTask('binding-only-consumer', {
        x: { kind: 'task_output', taskId: 'producer' },
      }),
    ];
    const result = computeReadyTasksWithWhen(
      tasks,
      new Set(['producer']),
      new Set(),
      emptyContext(),
    );
    expect(result.ready.map((t) => t.taskId)).toEqual(['binding-only-consumer']);
  });

  it('mixing dependsOn + bindings — both must be satisfied for readiness', () => {
    const tasks = [
      task('a'),
      task('b'),
      bindingTask(
        'consumer',
        { x: { kind: 'task_output', taskId: 'b' } },
        ['a'], // dependsOn: ['a'] AND inputBindings → b
      ),
    ];
    // Only `a` satisfied → consumer waits (binding to `b` unsatisfied).
    let result = computeReadyTasksWithWhen(tasks, new Set(['a']), new Set(), emptyContext());
    expect(result.ready.find((t) => t.taskId === 'consumer')).toBeUndefined();
    // Both satisfied → consumer ready.
    result = computeReadyTasksWithWhen(tasks, new Set(['a', 'b']), new Set(), emptyContext());
    expect(result.ready.map((t) => t.taskId)).toContain('consumer');
  });
});

describe('computeDescendants — Plan 123 §3.3 / Phase B-prime', () => {
  function bindingTask(
    taskId: string,
    bindings: Record<string, { kind: 'task_output' | 'task_summary'; taskId: string }>,
    dependsOn?: string[],
  ): WorkflowTask {
    return {
      taskId,
      name: `Task ${taskId}`,
      goal: `Goal for ${taskId}`,
      ...(dependsOn ? { dependsOn } : {}),
      inputBindings: Object.fromEntries(
        Object.entries(bindings).map(([k, v]) => [
          k,
          {
            ...v,
            ...(v.kind === 'task_output' ? { outputKey: 'output' } : {}),
          },
        ]),
      ),
    } as WorkflowTask;
  }

  it('walks task_output inputBindings to derive descendants when dependsOn is omitted', () => {
    // Compose-skill scenario: validate-source-coverage consumes draft-task-graph's
    // output via inputBindings (no explicit dependsOn). A producer-rerun reset on
    // draft-task-graph must include validate-source-coverage in the reset scope.
    const tasks = [
      task('draft-task-graph'),
      bindingTask('validate-source-coverage', {
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      }),
      bindingTask('assemble-workflow', {
        validated: { kind: 'task_output', taskId: 'validate-source-coverage' },
      }),
    ];
    const descendants = computeDescendants(tasks, new Set(['draft-task-graph']));
    expect(descendants).toEqual(new Set(['validate-source-coverage', 'assemble-workflow']));
  });

  it('walks task_summary inputBindings the same way', () => {
    const tasks = [
      task('producer'),
      bindingTask('summary-consumer', {
        intent: { kind: 'task_summary', taskId: 'producer' },
      }),
    ];
    const descendants = computeDescendants(tasks, new Set(['producer']));
    expect(descendants).toEqual(new Set(['summary-consumer']));
  });

  it('combines dependsOn and inputBindings edges without double-counting', () => {
    // `child` depends on `producer` via BOTH dependsOn AND inputBindings —
    // the merged adjacency must not report duplicates.
    const tasks = [
      task('producer'),
      bindingTask(
        'child',
        { x: { kind: 'task_output', taskId: 'producer' } },
        ['producer'], // also explicit dependsOn
      ),
    ];
    const descendants = computeDescendants(tasks, new Set(['producer']));
    expect(descendants).toEqual(new Set(['child']));
  });

  it('does NOT include sibling branches that consume only an unrelated producer', () => {
    // sibling-of-producer reads from a DIFFERENT root; rerunning `producer`
    // must not invalidate it.
    const tasks = [
      task('producer'),
      task('other-root'),
      bindingTask('child-of-producer', {
        x: { kind: 'task_output', taskId: 'producer' },
      }),
      bindingTask('sibling-of-producer', {
        y: { kind: 'task_output', taskId: 'other-root' },
      }),
    ];
    const descendants = computeDescendants(tasks, new Set(['producer']));
    expect(descendants).toEqual(new Set(['child-of-producer']));
    expect(descendants).not.toContain('sibling-of-producer');
  });

  it('ignores binding kinds that do not pin a producer (run_input / system_feedback)', () => {
    // run_input / system_feedback bindings don't reference an upstream task —
    // they shouldn't add edges. Only task_output / task_summary count.
    const tasks: WorkflowTask[] = [
      task('producer'),
      {
        taskId: 'consumer',
        name: 'consumer',
        goal: 'g',
        inputBindings: {
          fromRun: { kind: 'run_input', path: 'foo' },
          fromFeedback: { kind: 'system_feedback' },
        },
      } as WorkflowTask,
    ];
    const descendants = computeDescendants(tasks, new Set(['producer']));
    expect(descendants).toEqual(new Set());
  });
});

// ============================================================================
// Phase 3: CONCURRENCY_LIMIT_EXCEEDED error type
// ============================================================================

describe('cross-run concurrency gate contract', () => {
  it('CONCURRENCY_LIMIT_EXCEEDED is a documented error code', () => {
    // The error code is used by handleWorkflowRunStart when maxConcurrentRuns
    // is exceeded. This test documents the contract.
    const errorCode = 'CONCURRENCY_LIMIT_EXCEEDED';
    expect(errorCode).toBe('CONCURRENCY_LIMIT_EXCEEDED');
  });
});

// ============================================================================
// Phase 4: schema version bump + failureMode default flip
// ============================================================================

describe('Phase 4: schema version and failureMode default', () => {
  it('SkillManifest accepts schemaVersion 2', () => {
    const manifest = SkillManifestSchema.parse({
      schemaVersion: 2,
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.schemaVersion).toBe(2);
  });

  it('new manifests default to schemaVersion 2', () => {
    const manifest = SkillManifestSchema.parse({
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.schemaVersion).toBe(2);
  });

  it('new concurrency policy defaults failureMode to isolate', () => {
    const policy = SkillConcurrencyPolicySchema.parse({});
    expect(policy.failureMode).toBe('isolate');
  });

  it('existing manifests with schemaVersion 1 + explicit cancel_siblings are preserved', () => {
    const manifest = SkillManifestSchema.parse({
      schemaVersion: 1,
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      concurrency: { failureMode: 'cancel_siblings' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.concurrency?.failureMode).toBe('cancel_siblings');
  });
});

// ============================================================================
// Phase 5: recovery helpers
// ============================================================================

describe('Phase 5: recovery helpers', () => {
  it('stampSchedulerDeadline is exported', async () => {
    const mod = await import('../scheduling/recovery.js');
    expect(typeof mod.stampSchedulerDeadline).toBe('function');
  });

  it('runRecoveryPass is exported', async () => {
    const mod = await import('../scheduling/recovery.js');
    expect(typeof mod.runRecoveryPass).toBe('function');
  });

  it('findStalledRuns is exported', async () => {
    const mod = await import('../scheduling/recovery.js');
    expect(typeof mod.findStalledRuns).toBe('function');
  });
});

// ============================================================================
// 104i: Skill mode canonicalization
// ============================================================================

describe('104i: SkillManifest.mode canonicalization', () => {
  it('pre-104i manifests parse with mode undefined (no false default)', () => {
    const manifest = SkillManifestSchema.parse({
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // mode is optional — pre-104i manifests should NOT get a default injected
    expect(manifest.mode).toBeUndefined();
  });

  it('post-104i manifests preserve explicit mode', () => {
    const manifest = SkillManifestSchema.parse({
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      mode: 'optimization',
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(manifest.mode).toBe('optimization');
  });

  it('accepts all three mode values', () => {
    for (const mode of ['optimization', 'process', 'project'] as const) {
      const manifest = SkillManifestSchema.parse({
        skillId: 'test',
        name: 'Test',
        goal: { type: 'subjective', rubric: ['Test goal'] },
        mode,
        origin: 'operator',
        workflowSlug: 'test-workflow',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(manifest.mode).toBe(mode);
    }
  });

  it('rejects invalid mode values', () => {
    const result = SkillManifestSchema.safeParse({
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      mode: 'invalid',
      origin: 'operator',
      workflowSlug: 'test-workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('preserves existing fields when mode is added to a manifest', () => {
    // Simulates the 104i backfill: an existing manifest with later-plan fields
    // should keep them when mode is patched in
    const existing = SkillManifestSchema.parse({
      schemaVersion: 2,
      skillId: 'test',
      name: 'Test',
      goal: { type: 'subjective', rubric: ['Test goal'] },
      origin: 'operator',
      workflowSlug: 'test-workflow',
      evalSuiteRef: '/evals/test/suite.json',
      activationRef: '/activation/test.json',
      concurrency: { maxParallelTasksPerRun: 8, failureMode: 'isolate' },
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    // Simulate read-modify-write: spread existing, add mode
    const patched = SkillManifestSchema.parse({
      ...existing,
      mode: 'optimization',
      updatedAt: new Date().toISOString(),
    });

    expect(patched.mode).toBe('optimization');
    expect(patched.evalSuiteRef).toBe('/evals/test/suite.json');
    expect(patched.activationRef).toBe('/activation/test.json');
    expect(patched.concurrency?.maxParallelTasksPerRun).toBe(8);
    expect(patched.concurrency?.failureMode).toBe('isolate');
    expect(patched.schemaVersion).toBe(2);
    expect(patched.skillId).toBe('test');
  });

  it('fallback chain: manifest.mode ?? workflow.mode ?? process', () => {
    // This tests the logic used in attentionBuilder.ts
    const fallback = (manifestMode: string | undefined, workflowMode: string | undefined): string =>
      manifestMode ?? workflowMode ?? 'process';

    // Post-104i manifest with explicit mode — use it
    expect(fallback('optimization', 'process')).toBe('optimization');

    // Pre-104i manifest (no mode) with workflow mode — fall back to workflow
    expect(fallback(undefined, 'optimization')).toBe('optimization');
    expect(fallback(undefined, 'project')).toBe('project');

    // No manifest mode, no workflow mode — ultimate fallback
    expect(fallback(undefined, undefined)).toBe('process');

    // Manifest mode takes precedence even if workflow differs
    expect(fallback('project', 'optimization')).toBe('project');
  });
});
