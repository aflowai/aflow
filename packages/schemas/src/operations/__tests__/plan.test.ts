import { describe, expect, it } from 'vitest';
import {
  buildOperationId,
  getOperation,
  getOperationsByStepType,
  isPlanOperation,
  isRunnerExcludedOperation,
  PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
  PLAN_NODE_OPEN_HAS_NO_OUTCOME_MESSAGE,
  PLAN_NODE_POSITION_MAX,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_TITLE_ONE_LINE_MESSAGE,
  PLAN_NODE_UPDATE_EMPTY_MESSAGE,
  CoachLearningScopeSchema,
  planDependencyMet,
  PlanNodeCreateInputSchema,
  PLAN_NODE_LIVE_CHECK_KIND_MESSAGE,
  PlanBoardNextSchema,
  PlanStreamAnswerSchema,
  PlanNodeOpenSchema,
  PLAN_STREAM_SPEND_CENTS_MAX,
  PlanNodeLearnInputSchema,
  PlanNodeLinkInputSchema,
  PlanNodeListInputSchema,
  PlanNodeListOutputSchema,
  PlanNodeSummarySchema,
  PlanNodeUpdateInputSchema,
  PLAN_NODE_LIST_DEFAULT_LIMIT,
  PLAN_NODE_LIST_MAX_LIMIT,
  WorkflowRunStartInputSchema,
} from '../../index.js';

const NODE_ID = '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11';

it('bounds operator spend ceilings by the exported maximum', () => {
  expect(
    PlanNodeOpenSchema.safeParse({ expectedRevision: 1, spendCents: PLAN_STREAM_SPEND_CENTS_MAX })
      .success,
  ).toBe(true);
  expect(
    PlanNodeOpenSchema.safeParse({
      expectedRevision: 1,
      spendCents: PLAN_STREAM_SPEND_CENTS_MAX + 1,
    }).success,
  ).toBe(false);
});

const PLAN_OPERATIONS = {
  create: 'write',
  update: 'write',
  get: 'read',
  list: 'read',
  link: 'write',
  next: 'read',
  learn: 'write',
  depend: 'write',
} as const;

describe('plan.node operations (Plan 322)', () => {
  it('registers exactly the four P0 operations, P1’s link, P2’s learn and depend and P2b’s next, read or write as the verb says', () => {
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

  it('refuses an outcome on an open status, since reopening clears it', () => {
    const result = PlanNodeUpdateInputSchema.safeParse({
      nodeId: NODE_ID,
      expectedRevision: 2,
      status: 'active',
      outcome: 'Still holds.',
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['outcome'],
        message: PLAN_NODE_OPEN_HAS_NO_OUTCOME_MESSAGE,
      }),
    ]);
  });

  it('takes a goal alone, held to the same ceiling as a created node’s', () => {
    const update = { nodeId: NODE_ID, expectedRevision: 2 };
    expect(PlanNodeUpdateInputSchema.safeParse({ ...update, goal: 'Amended.' }).success).toBe(true);
    expect(
      PlanNodeUpdateInputSchema.safeParse({
        ...update,
        goal: 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(PlanNodeUpdateInputSchema.safeParse({ ...update, goal: 7 }).success).toBe(false);
  });

  it('names goal among the fields its registration says it changes', () => {
    const update = getOperation(buildOperationId('plan', 'node', 'update'));
    expect(update?.usage.oneLine).toMatch(/\bgoal\b/);
    expect(PLAN_NODE_UPDATE_EMPTY_MESSAGE).toMatch(/\bgoal\b/);
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

describe('plan node title', () => {
  const base = { kind: 'execute', goal: 'g', criteria: 'c' };

  it('is one line, because the attention block renders one line per node', () => {
    for (const title of ['315 · Local first-run\nergonomics', 'carriage\rreturn']) {
      for (const result of [
        PlanNodeCreateInputSchema.safeParse({ ...base, title }),
        PlanNodeUpdateInputSchema.safeParse({ nodeId: NODE_ID, expectedRevision: 1, title }),
      ]) {
        expect(result.error?.issues).toEqual([
          expect.objectContaining({ path: ['title'], message: PLAN_NODE_TITLE_ONE_LINE_MESSAGE }),
        ]);
      }
    }
  });

  it('takes a line break at either end as the whitespace it trims', () => {
    expect(PlanNodeCreateInputSchema.parse({ ...base, title: '\n315 · ergonomics\n' }).title).toBe(
      '315 · ergonomics',
    );
  });
});

describe('PlanNodeLinkInputSchema', () => {
  const RUN_ID = '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

  it('takes each kind’s ref in its own form', () => {
    for (const link of [
      { kind: 'run', ref: RUN_ID },
      { kind: 'session', ref: RUN_ID },
      { kind: 'campaign', ref: RUN_ID },
      { kind: 'pull_request', ref: 'https://github.com/aflowai/aflow/pull/80' },
      { kind: 'document', ref: '/plans/322.md' },
      { kind: 'finding', ref: 'F114', label: 'Findings out of the plan file' },
    ]) {
      expect(
        PlanNodeLinkInputSchema.safeParse({ nodeId: NODE_ID, ...link }).success,
        link.kind,
      ).toBe(true);
    }
  });

  it('refuses an id that is not one, and a pull request that is not a URL, naming the form', () => {
    const notAnId = PlanNodeLinkInputSchema.safeParse({ nodeId: NODE_ID, kind: 'run', ref: '80' });
    expect(notAnId.error?.issues).toEqual([
      expect.objectContaining({ path: ['ref'], message: expect.stringContaining('a UUID') }),
    ]);
    const notAUrl = PlanNodeLinkInputSchema.safeParse({
      nodeId: NODE_ID,
      kind: 'pull_request',
      ref: '#80',
    });
    expect(notAUrl.error?.issues).toEqual([
      expect.objectContaining({ path: ['ref'], message: expect.stringContaining('URL') }),
    ]);
  });
});

describe('workflow.run.start planNodeId', () => {
  it('takes the node a run serves, and nothing that is not a node id', () => {
    expect(
      WorkflowRunStartInputSchema.parse({ slug: 'commission-change', planNodeId: NODE_ID }),
    ).toMatchObject({ planNodeId: NODE_ID });
    expect(
      WorkflowRunStartInputSchema.safeParse({ slug: 'commission-change', planNodeId: '315' })
        .success,
    ).toBe(false);
  });
});

describe('plan node prose caps', () => {
  const base = { kind: 'investigate', title: 'Why does the first start stall?' };

  it('holds prose in the tens of thousands', () => {
    const long = 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS);
    expect(PLAN_NODE_PROSE_MAX_CHARS).toBeGreaterThanOrEqual(64_000);
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

describe('plan node position', () => {
  const base = { kind: 'execute', title: 't', goal: 'g', criteria: 'c' };

  it('holds the whole INTEGER range of its column and refuses past it, saying how to order instead', () => {
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...base, position: PLAN_NODE_POSITION_MAX }).success,
    ).toBe(true);
    for (const result of [
      PlanNodeCreateInputSchema.safeParse({ ...base, position: PLAN_NODE_POSITION_MAX + 1 }),
      PlanNodeUpdateInputSchema.safeParse({
        nodeId: NODE_ID,
        expectedRevision: 1,
        position: PLAN_NODE_POSITION_MAX + 1,
      }),
    ]) {
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path: ['position'],
          message: expect.stringContaining('leave it out to place the node after its last sibling'),
        }),
      ]);
    }
  });
});

describe('PlanNodeListInputSchema', () => {
  it('defaults to the open nodes, bounded', () => {
    const parsed = PlanNodeListInputSchema.parse({});
    expect(parsed.status).toEqual(['active', 'waiting', 'blocked']);
    expect(parsed.limit).toBeGreaterThan(0);
    expect(parsed).not.toHaveProperty('cursor');
  });

  it('lists a 65-node plan in one page by default', () => {
    expect(PlanNodeListInputSchema.parse({}).limit).toBeGreaterThanOrEqual(65);
    expect(PLAN_NODE_LIST_DEFAULT_LIMIT).toBeLessThanOrEqual(PLAN_NODE_LIST_MAX_LIMIT);
  });

  it('refuses an empty cursor, and an offset', () => {
    expect(PlanNodeListInputSchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(PlanNodeListInputSchema.safeParse({ offset: 3 }).success).toBe(false);
  });
});

describe('PlanNodeListOutputSchema', () => {
  const SUMMARY = {
    nodeId: NODE_ID,
    parentId: null,
    kind: 'execute',
    title: 'Plan 322',
    status: 'done',
    revision: 2,
    position: 0,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
    closedAt: '2026-10-21T09:00:00.000Z',
  };

  it('carries when each node was created, and when a closed one closed', () => {
    expect(PlanNodeSummarySchema.parse(SUMMARY)).toEqual(SUMMARY);
    const { closedAt: _closedAt, ...open } = { ...SUMMARY, status: 'active' };
    expect(PlanNodeSummarySchema.parse(open)).toEqual(open);
    const { createdAt: _createdAt, ...undated } = SUMMARY;
    expect(PlanNodeSummarySchema.safeParse(undated).success).toBe(false);
  });

  it('a truncated list says how many nodes match and where the next page starts', () => {
    const page = {
      nodes: [SUMMARY],
      truncated: { bound: 'limit', value: 1, matched: 65, next: { cursor: 'WzEsImFiYyJd' } },
    };
    expect(PlanNodeListOutputSchema.parse(page)).toEqual(page);
    expect(
      PlanNodeListOutputSchema.safeParse({
        nodes: [SUMMARY],
        truncated: { bound: 'limit', value: 1 },
      }).success,
    ).toBe(false);
  });

  it('a read cut short by depth or nodes may end with no next page, and says how to reach the rest', () => {
    const last = { nodes: [SUMMARY], truncated: { bound: 'depth', value: 64, matched: 1 } };
    expect(PlanNodeListOutputSchema.parse(last)).toEqual(last);
    const said = PlanNodeListOutputSchema.shape.truncated.description ?? '';
    expect(said).toContain('Once `next` is absent');
    expect(said).toContain('`rootId`');
  });
});

describe('Plan 322 P2 — learnings scoped to a node, dependencies between nodes', () => {
  it('a coach learning may be scoped to a plan node, by its id', () => {
    expect(CoachLearningScopeSchema.parse({ kind: 'plan', planNodeId: NODE_ID })).toEqual({
      kind: 'plan',
      planNodeId: NODE_ID,
    });
    expect(CoachLearningScopeSchema.safeParse({ kind: 'plan' }).success).toBe(false);
    expect(
      CoachLearningScopeSchema.safeParse({ kind: 'plan', planNodeId: NODE_ID, skillSlug: 'x' })
        .success,
    ).toBe(false);
  });

  it('learn requires the runs a learning was drawn from', () => {
    const learning = {
      nodeId: NODE_ID,
      kind: 'heuristic',
      statement: 'Rerun a timeout once before fixing it.',
      confidence: 'low',
    };
    expect(PlanNodeLearnInputSchema.safeParse(learning).success).toBe(false);
    expect(
      PlanNodeLearnInputSchema.safeParse({
        ...learning,
        evidence: { citations: [{ runId: NODE_ID }] },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['done', 'done', true],
    ['done', 'dropped', false],
    ['dropped', 'dropped', true],
    ['dropped', 'done', false],
    ['closed', 'done', true],
    ['closed', 'dropped', true],
    ['closed', 'active', false],
    ['done', 'blocked', false],
  ] as const)('a dependency waiting for %s is met by a node %s: %s', (condition, status, met) => {
    expect(planDependencyMet(condition, status)).toBe(met);
  });
});

it('requires the proposal to name its parent root', () => {
  const board = {
    scope: 'board',
    decisions: [],
    deferred: 0,
    waits: [],
    roots: 1,
    propose: { reason: 'Next', title: 'Title', goal: 'Goal', criteria: 'Criteria' },
  };
  expect(PlanBoardNextSchema.safeParse(board).success).toBe(false);
  expect(
    PlanBoardNextSchema.safeParse({ ...board, propose: { ...board.propose, parentId: NODE_ID } })
      .success,
  ).toBe(true);
});

it('teaches the kind required for a live check and accepts both root and child placement', () => {
  const create = {
    kind: 'execute',
    title: 'Check',
    goal: 'Goal',
    criteria: 'Criteria',
    liveCheck: { pullRequest: 'https://github.com/aflowai/aflow/pull/1' },
  };
  const refused = PlanNodeCreateInputSchema.safeParse(create);
  expect(refused.success).toBe(false);
  if (!refused.success)
    expect(refused.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['kind'],
        message: 'A live check must have kind `investigate`.',
      }),
    );
  expect(PLAN_NODE_LIVE_CHECK_KIND_MESSAGE).toBe('A live check must have kind `investigate`.');
  for (const placement of [{}, { parentId: NODE_ID }]) {
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...create, ...placement, kind: 'investigate' }).success,
    ).toBe(true);
  }
});

it('defines waitsOn as the wait line anywhere in the note', () => {
  const ask = PlanStreamAnswerSchema.options.find(
    (option) => option.shape.decision.value === 'ask',
  );
  if (!ask || !('waitsOn' in ask.shape)) throw new Error('Missing ask contract');
  expect(ask.shape.waitsOn.description).toContain('wait line anywhere in its note');
  expect(ask.shape.waitsOn.description).toContain('no room');
});

it('describes proposals beside unrelated person waits', () => {
  const description = PlanBoardNextSchema.shape.propose.description;
  expect(description).toContain('exhausted active root');
  expect(description).toContain('without blocked scope, waiting scope or declined proposals');
  expect(description).toContain('even when unrelated roots await people');
});

it('directs residents to record the merge before closing a node whose criteria are met', () => {
  const merge = PlanStreamAnswerSchema.options.find(
    (option) => option.shape.decision.value === 'record_merge',
  );
  const description = merge && 'liveCheck' in merge.shape ? merge.shape.liveCheck.description : '';
  expect(description).toContain('Only a person approves the live check');
  const link = merge && 'link' in merge.shape ? merge.shape.link.description : '';
  expect(link).toContain('before closing the node');
  expect(link).toContain('when its criteria are met');
  const guidance = getOperation('plan.node.next')?.usage.pitfalls?.find((text) =>
    text.startsWith('record_merge:'),
  );
  expect(guidance).toContain('plan.node.link before closing');
  expect(guidance).toContain('When criteria are met, write status "done"');
});
