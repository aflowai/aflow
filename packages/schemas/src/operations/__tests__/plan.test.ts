import { describe, expect, it } from 'vitest';
import {
  buildOperationId,
  getOperation,
  getOperationsByStepType,
  isPlanOperation,
  isRunnerExcludedOperation,
  PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_UPDATE_EMPTY_MESSAGE,
  PlanNodeCreateInputSchema,
  PlanNodeListInputSchema,
  PlanNodeUpdateInputSchema,
} from '../../index.js';

const NODE_ID = '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11';

const PLAN_OPERATIONS = {
  create: 'write',
  update: 'write',
  get: 'read',
  list: 'read',
} as const;

describe('plan.node operations (Plan 322 P0)', () => {
  it('registers exactly the four P0 operations, read or write as the verb says', () => {
    const registered = [...getOperationsByStepType('plan').keys()].sort();
    expect(registered).toEqual(
      Object.keys(PLAN_OPERATIONS)
        .map((verb) => buildOperationId('plan', 'node', verb))
        .sort(),
    );
    for (const [verb, accessMode] of Object.entries(PLAN_OPERATIONS)) {
      const op = getOperation(buildOperationId('plan', 'node', verb));
      expect(op?.capabilityGroupId, verb).toBe('plan.node');
      expect(op?.accessMode, verb).toBe(accessMode);
      expect(op?.mutates, verb).toBe(accessMode === 'write');
      expect(op?.agentTool, verb).toBe(true);
      expect(op?.opTaskOnly, verb).toBe(false);
      expect(op?.semanticDescription.length, verb).toBeGreaterThan(0);
      expect(op?.usage.whenToUse.length, verb).toBeGreaterThan(0);
      expect(op?.usage.pitfalls, verb).toBeDefined();
    }
  });

  it('teaches that a round starts from the node, where only usage can say it', () => {
    const get = getOperation(buildOperationId('plan', 'node', 'get'));
    expect(get?.usage.whenToUse.join(' ')).toMatch(/Before briefing a round/);
    expect(get?.usage.pitfalls?.join(' ')).toMatch(/brief is the node’s goal and criteria/);
  });

  it('accepts every minimal example its own input schema', () => {
    for (const op of getOperationsByStepType('plan').values()) {
      expect(op.inputZod.safeParse(op.usage.minimalExampleInput).success, op.operationId).toBe(
        true,
      );
    }
  });

  it('isPlanOperation covers registered, future and bare ids — and nothing else', () => {
    for (const id of getOperationsByStepType('plan').keys()) expect(isPlanOperation(id)).toBe(true);
    expect(isPlanOperation('plan.node.link')).toBe(true);
    expect(isPlanOperation('plan.something.new')).toBe(true);
    expect(isPlanOperation('plan')).toBe(true);
    expect(isPlanOperation('planner.node.get')).toBe(false);
    expect(isPlanOperation('workflow.plan.get')).toBe(false);
    expect(isPlanOperation('memory.store.get')).toBe(false);
  });

  it('keeps every plan and eval-plane operation from a Runner, and nothing else', () => {
    const excluded = [
      ...getOperationsByStepType('plan').keys(),
      'plan.node.link',
      'eval.batch.run',
    ];
    for (const id of excluded) expect(isRunnerExcludedOperation(id), id).toBe(true);
    for (const id of ['eval.case.propose', 'planner.node.get', 'memory.store.get']) {
      expect(isRunnerExcludedOperation(id), id).toBe(false);
    }
  });
});

describe('PlanNodeUpdateInputSchema', () => {
  it('refuses done without an outcome, and says how to meet it', () => {
    const result = PlanNodeUpdateInputSchema.safeParse({
      nodeId: NODE_ID,
      expectedRevision: 1,
      status: 'done',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['outcome'], message: PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE }),
    ]);
  });

  it('accepts done with an outcome', () => {
    expect(
      PlanNodeUpdateInputSchema.safeParse({
        nodeId: NODE_ID,
        expectedRevision: 1,
        status: 'done',
        outcome: 'The fresh-machine start reached a serving space twice.',
      }).success,
    ).toBe(true);
  });

  it('refuses an update that changes nothing', () => {
    const result = PlanNodeUpdateInputSchema.safeParse({ nodeId: NODE_ID, expectedRevision: 3 });
    expect(result.error?.issues.map((i) => i.message)).toEqual([PLAN_NODE_UPDATE_EMPTY_MESSAGE]);
  });

  it('takes a null parent as a move to the root', () => {
    expect(
      PlanNodeUpdateInputSchema.safeParse({ nodeId: NODE_ID, expectedRevision: 1, parentId: null })
        .success,
    ).toBe(true);
  });

  it('requires the revision the change was decided against', () => {
    expect(PlanNodeUpdateInputSchema.safeParse({ nodeId: NODE_ID, note: 'next' }).success).toBe(
      false,
    );
  });
});

describe('plan node prose caps', () => {
  const base = { kind: 'investigate', title: 'Why does the first start stall?' };

  it('holds prose in the thousands', () => {
    const long = 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS);
    expect(PLAN_NODE_PROSE_MAX_CHARS).toBeGreaterThanOrEqual(1000);
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...base, goal: long, criteria: long, note: long })
        .success,
    ).toBe(true);
    expect(
      PlanNodeUpdateInputSchema.safeParse({
        nodeId: NODE_ID,
        expectedRevision: 1,
        status: 'done',
        outcome: long,
      }).success,
    ).toBe(true);
  });

  it('refuses past the ceiling', () => {
    const over = 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS + 1);
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...base, goal: over, criteria: 'c' }).success,
    ).toBe(false);
  });
});

describe('PlanNodeListInputSchema', () => {
  it('defaults to the open nodes, bounded', () => {
    const parsed = PlanNodeListInputSchema.parse({});
    expect(parsed.status).toEqual(['active', 'waiting', 'blocked']);
    expect(parsed.limit).toBeGreaterThan(0);
  });
});
