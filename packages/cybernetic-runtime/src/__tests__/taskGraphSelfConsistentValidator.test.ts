import { describe, it, expect } from 'vitest';
import type { RuntimeValidatorContext } from '@aflow/schemas';
import { taskGraphSelfConsistentValidator } from '../scheduling/taskGraphSelfConsistentValidator.js';

const ctx: RuntimeValidatorContext = {
  tenantId: 'tenant-1',
  spaceId: 'space-1',
  runId: 'run-1',
  db: {} as never,
};

describe('taskGraphSelfConsistentValidator — happy paths', () => {
  it('accepts a single-task draft with no references', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      { tasks: [{ type: 'agent', taskId: 't1', goal: 'g' }] },
      ctx,
    );
    expect(issues).toEqual([]);
  });

  it('accepts a linear dependsOn chain a → b → c', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'a', goal: 'g' },
          { type: 'agent', taskId: 'b', goal: 'g', dependsOn: ['a'] },
          { type: 'agent', taskId: 'c', goal: 'g', dependsOn: ['b'] },
        ],
      },
      ctx,
    );
    expect(issues).toEqual([]);
  });

  it('accepts a consumes chain when produces.key matches', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          {
            type: 'agent',
            taskId: 'a',
            goal: 'g',
            produces: [{ key: 'data', shape: {}, semantics: 'data' }],
          },
          {
            type: 'agent',
            taskId: 'b',
            goal: 'g',
            consumes: [{ taskId: 'a', outputKey: 'data', bindAs: 'incoming' }],
          },
        ],
      },
      ctx,
    );
    expect(issues).toEqual([]);
  });

  it('returns no issues for an empty draft', async () => {
    const issues = await taskGraphSelfConsistentValidator({ tasks: [] }, ctx);
    expect(issues).toEqual([]);
  });

  it('returns no issues for non-object input (defensive)', async () => {
    expect(await taskGraphSelfConsistentValidator(null, ctx)).toEqual([]);
    expect(await taskGraphSelfConsistentValidator('not-an-object', ctx)).toEqual([]);
  });
});

describe('taskGraphSelfConsistentValidator — dangling references', () => {
  it('flags dependsOn pointing at a non-existent taskId', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'a', goal: 'g' },
          { type: 'agent', taskId: 'b', goal: 'g', dependsOn: ['no-such-task'] },
        ],
      },
      ctx,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['tasks', 1, 'dependsOn', 0]);
    expect(issues[0]?.message).toMatch(/no such task is declared/);
    expect(issues[0]?.params?.['violation']).toBe('dangling-depends-on');
    expect(issues[0]?.params?.['missingTaskId']).toBe('no-such-task');
  });

  it('flags consumes.taskId pointing at a non-existent taskId', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          {
            type: 'agent',
            taskId: 'b',
            goal: 'g',
            consumes: [{ taskId: 'no-such-task', outputKey: 'x', bindAs: 'i' }],
          },
        ],
      },
      ctx,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['tasks', 0, 'consumes', 0, 'taskId']);
    expect(issues[0]?.params?.['violation']).toBe('dangling-consumes-task');
  });
});

describe('taskGraphSelfConsistentValidator — outputKey mismatch', () => {
  it('flags consumes.outputKey not declared by the producer', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          {
            type: 'agent',
            taskId: 'a',
            goal: 'g',
            produces: [{ key: 'data', shape: {} }],
          },
          {
            type: 'agent',
            taskId: 'b',
            goal: 'g',
            consumes: [{ taskId: 'a', outputKey: 'wrongKey', bindAs: 'i' }],
          },
        ],
      },
      ctx,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['tasks', 1, 'consumes', 0, 'outputKey']);
    expect(issues[0]?.message).toMatch(/Available keys on "a": data/);
    expect(issues[0]?.params?.['violation']).toBe('unknown-output-key');
    expect(issues[0]?.params?.['availableKeys']).toEqual(['data']);
  });
});

describe('taskGraphSelfConsistentValidator — duplicate task IDs', () => {
  it('flags repeated taskId on the second occurrence', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'a', goal: 'g1' },
          { type: 'agent', taskId: 'a', goal: 'g2' },
        ],
      },
      ctx,
    );
    const dup = issues.find((i) => i.params?.['violation'] === 'duplicate-task-id');
    expect(dup).toBeDefined();
    expect(dup?.path).toEqual(['tasks', 1, 'taskId']);
    expect(dup?.params?.['firstIndex']).toBe(0);
    expect(dup?.params?.['duplicateIndex']).toBe(1);
  });
});

describe('taskGraphSelfConsistentValidator — cycles', () => {
  it('flags a 2-cycle via dependsOn', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'a', goal: 'g', dependsOn: ['b'] },
          { type: 'agent', taskId: 'b', goal: 'g', dependsOn: ['a'] },
        ],
      },
      ctx,
    );
    const cycleIssues = issues.filter((i) => i.params?.['violation'] === 'cycle');
    expect(cycleIssues).toHaveLength(2);
    expect(cycleIssues.every((i) => i.message.includes('cycle'))).toBe(true);
  });

  it('flags a cycle introduced by consumes (a consumes b, b consumes a)', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          {
            type: 'agent',
            taskId: 'a',
            goal: 'g',
            produces: [{ key: 'x', shape: {} }],
            consumes: [{ taskId: 'b', outputKey: 'y', bindAs: 'iy' }],
          },
          {
            type: 'agent',
            taskId: 'b',
            goal: 'g',
            produces: [{ key: 'y', shape: {} }],
            consumes: [{ taskId: 'a', outputKey: 'x', bindAs: 'ix' }],
          },
        ],
      },
      ctx,
    );
    const cycleIssues = issues.filter((i) => i.params?.['violation'] === 'cycle');
    expect(cycleIssues.length).toBeGreaterThanOrEqual(2);
  });

  it('does not run cycle detection when there are dangling references', async () => {
    // A dangling reference is a more actionable error and would otherwise
    // produce noisy "cycle" output as well; we suppress it.
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'a', goal: 'g', dependsOn: ['ghost'] },
          { type: 'agent', taskId: 'b', goal: 'g', dependsOn: ['a'] },
        ],
      },
      ctx,
    );
    expect(issues.some((i) => i.params?.['violation'] === 'cycle')).toBe(false);
    expect(issues.some((i) => i.params?.['violation'] === 'dangling-depends-on')).toBe(true);
  });
});

describe('taskGraphSelfConsistentValidator — multiple root tasks', () => {
  it('flags two tasks with no predecessors', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'fetch', goal: 'g' },
          { type: 'agent', taskId: 'analyze', goal: 'g' },
          { type: 'agent', taskId: 'process', goal: 'g', dependsOn: ['fetch', 'analyze'] },
        ],
      },
      ctx,
    );
    expect(issues.some((i) => i.message.includes('Multiple root tasks'))).toBe(true);
  });

  it('flags a human task with no dependsOn alongside another root task', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'train', goal: 'g' },
          {
            type: 'human',
            taskId: 'approve',
            goal: 'g',
            pauseInstruction: 'approve?',
            intent: 'approve',
          },
          { type: 'agent', taskId: 'submit', goal: 'g', dependsOn: ['train', 'approve'] },
        ],
      },
      ctx,
    );
    expect(issues.some((i) => i.message.includes('Multiple root tasks'))).toBe(true);
  });

  it('accepts a single root with fan-out', async () => {
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'init', goal: 'g' },
          { type: 'agent', taskId: 'fetch', goal: 'g', dependsOn: ['init'] },
          { type: 'agent', taskId: 'analyze', goal: 'g', dependsOn: ['init'] },
          { type: 'agent', taskId: 'process', goal: 'g', dependsOn: ['fetch', 'analyze'] },
        ],
      },
      ctx,
    );
    expect(issues.filter((i) => i.message.includes('Multiple root tasks'))).toHaveLength(0);
  });

  it('credits a human task `approves` as a predecessor (not a second root)', async () => {
    // The approval gate uses `approves: ['train']` to wire ordering instead of
    // dependsOn. The root check must credit approves edges — otherwise the gate
    // is false-flagged as a second root.
    const issues = await taskGraphSelfConsistentValidator(
      {
        tasks: [
          { type: 'agent', taskId: 'train', goal: 'g' },
          {
            type: 'human',
            taskId: 'approve',
            goal: 'g',
            pauseInstruction: 'approve?',
            intent: 'approve',
            approves: ['train'],
          },
          { type: 'agent', taskId: 'submit', goal: 'g', dependsOn: ['approve', 'train'] },
        ],
      },
      ctx,
    );
    expect(issues.filter((i) => i.message.includes('Multiple root tasks'))).toHaveLength(0);
  });
});
