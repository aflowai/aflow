import { describe, expect, it } from 'vitest';
import { CoachProposableOpSchema, StagedChangeOpSchema } from '../cybernetic/stagedChange.js';

describe('Plan 113 — staged change ops', () => {
  describe('add_task', () => {
    it('rejects the legacy { taskId, goal } shape', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        taskId: 'task-c',
        goal: 'New task',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a full agent-task spec with upstream dependency', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'New task',
          type: 'agent',
          dependsOn: ['task-a'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a full operation-task spec', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        task: {
          taskId: 'persist',
          name: 'Persist',
          goal: 'Write to memory',
          type: 'operation',
          operation: 'memory.store.put',
          dependsOn: ['task-a'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a full human-task spec with pauseInstruction', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        task: {
          taskId: 'approve',
          name: 'Approve',
          goal: 'Operator approval gate',
          type: 'human',
          pauseInstruction: 'Approve before continuing',
          dependsOn: ['task-a'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts source: true with no dependsOn', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        source: true,
        task: { taskId: 'root', name: 'Root', goal: 'Root', type: 'agent' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown keys at the op level (strict)', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'g',
          type: 'agent',
        },
        bogus: 'should be rejected',
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown keys NESTED INSIDE task (no silent strip)', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'g',
          type: 'agent',
          dependsOn: ['task-a'],
          depndsOn: ['task-a'], // typo — must be rejected
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('update_task_dependencies', () => {
    it('accepts the canonical shape', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'update_task_dependencies',
        taskId: 'task-b',
        dependsOn: ['gate'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts source: true with empty dependsOn', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'update_task_dependencies',
        taskId: 'task-b',
        dependsOn: [],
        source: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown keys (strict)', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'update_task_dependencies',
        taskId: 'task-b',
        dependsOn: ['x'],
        extra: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('reorder_tasks (display-only)', () => {
    it('accepts the canonical shape', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'reorder_tasks',
        taskIds: ['task-b', 'task-a'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown keys', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'reorder_tasks',
        taskIds: ['task-b'],
        extra: 'no',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('update_task_goal', () => {
    it('rejects unknown keys', () => {
      const result = StagedChangeOpSchema.safeParse({
        op: 'update_task_goal',
        taskId: 't',
        newGoal: 'g',
        extra: 'x',
      });
      expect(result.success).toBe(false);
    });
  });

  /**
   * Parameterized strictness sweep — guarantees every op variant in the
   * discriminated union rejects unknown keys. If a future op is added
   * without `.strict()`, this catches it.
   */
  describe('every op variant rejects unknown keys', () => {
    type OpFixture = { op: string; minimal: Record<string, unknown> };
    const fixtures: OpFixture[] = [
      {
        op: 'update_task_goal',
        minimal: { op: 'update_task_goal', taskId: 't', newGoal: 'g' },
      },
      {
        op: 'update_task_context_spec',
        minimal: {
          op: 'update_task_context_spec',
          taskId: 't',
          contextSpec: { strategy: 'curated', contextPolicy: 'auto-optimize' },
        },
      },
      {
        op: 'add_task',
        minimal: {
          op: 'add_task',
          task: {
            taskId: 't',
            name: 'T',
            goal: 'g',
            type: 'agent',
            dependsOn: ['x'],
          },
        },
      },
      { op: 'remove_task', minimal: { op: 'remove_task', taskId: 't' } },
      { op: 'reorder_tasks', minimal: { op: 'reorder_tasks', taskIds: ['t'] } },
      {
        op: 'update_task_dependencies',
        minimal: { op: 'update_task_dependencies', taskId: 't', dependsOn: ['x'] },
      },
      {
        op: 'update_outcome_threshold',
        minimal: { op: 'update_outcome_threshold', outcomeId: 'o', newTarget: 0.5 },
      },
      {
        op: 'update_activation_hint',
        minimal: { op: 'update_activation_hint', newHint: 'hint' },
      },
      {
        op: 'add_trigger_pattern',
        minimal: { op: 'add_trigger_pattern', pattern: 'p' },
      },
      {
        op: 'update_iteration_policy',
        minimal: { op: 'update_iteration_policy', maxConsecutiveRuns: 3 },
      },
      {
        op: 'flag_pattern',
        minimal: { op: 'flag_pattern', patternDescription: 'desc' },
      },
      { op: 'block_workflow', minimal: { op: 'block_workflow', reason: 'r' } },
      { op: 'unblock_workflow', minimal: { op: 'unblock_workflow' } },
      {
        op: 'platform_issue',
        minimal: { op: 'platform_issue', subjectKind: 'runtime', summary: 's' },
      },
      {
        op: 'eval.criterion.remove',
        minimal: {
          op: 'eval.criterion.remove',
          skillSlug: 'wf',
          criterionId: 'c',
          rationale: 'r',
        },
      },
    ];

    for (const { op, minimal } of fixtures) {
      it(`${op} rejects unknown top-level keys`, () => {
        // First confirm the minimal payload itself parses (so the test
        // failure below is unambiguously about strictness, not shape).
        expect(StagedChangeOpSchema.safeParse(minimal).success).toBe(true);

        const withExtra = { ...minimal, __unexpected: 'x' };
        expect(StagedChangeOpSchema.safeParse(withExtra).success).toBe(false);
      });
    }
  });
});

describe('Plan 301 — the Coach union is narrower than the storable one', () => {
  /** Ops only an authoring skill proposes, never a Coach. */
  const AUTHORING_ONLY_OPS = ['eval_case_draft'];

  function opKinds(schema: unknown): string[] {
    let node: unknown = schema;
    for (let i = 0; i < 4; i++) {
      const def = (node as { _def?: { typeName?: string; schema?: unknown; options?: unknown[] } })
        ._def;
      if (!def) break;
      if (def.typeName === 'ZodEffects' && def.schema) {
        node = def.schema;
        continue;
      }
      if (Array.isArray(def.options)) {
        return def.options.map(
          (o) => (o as { shape: { op: { value: string } } }).shape.op.value as string,
        );
      }
      break;
    }
    throw new Error('not a discriminated union');
  }

  it('leaves authoring-only ops out of what a Coach can emit', () => {
    const coach = opKinds(CoachProposableOpSchema);
    const storable = opKinds(StagedChangeOpSchema);
    expect(storable.length).toBeGreaterThan(coach.length);
    expect(storable.filter((op) => !coach.includes(op)).sort()).toEqual([...AUTHORING_ONLY_OPS]);
  });

  it('refuses a drafted eval case on the Coach surface and accepts it on the rail', () => {
    const op = {
      op: 'eval_case_draft',
      workflowSlug: 'cs-desk-conversation',
      authoredBySkillId: 'eval-suite-design',
      content: {
        title: 'A refund is overdue from the merchant',
        stratum: { scenario: 'refund-status', direction: 'should_pause', tier: 'capability' },
        trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
        fixture: { tier: 'seeded' },
        provenance: { source: 'curated', workflowRevision: 1 },
        requirements: [
          { id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' },
        ],
        expectations: [
          {
            kind: 'simulation',
            name: 'opened no case',
            claims: ['no-case'],
            check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
          },
        ],
        rubrics: [],
      },
    };
    expect(CoachProposableOpSchema.safeParse(op).success).toBe(false);
    expect(StagedChangeOpSchema.safeParse(op).success).toBe(true);
  });
});
