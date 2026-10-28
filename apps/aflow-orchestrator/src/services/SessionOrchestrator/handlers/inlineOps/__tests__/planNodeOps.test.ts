/**
 * plan.node.* inline ops (Plan 322) — thin adapters over the plan engine:
 * input parsed with its refinement, the engine's refusals surfaced as
 * validation errors carrying their details, the writing session recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
  PLAN_BOARD_DECISIONS_DEFAULT,
  PLAN_STREAM_ATTEMPTS_DEFAULT,
  PlanNodeRefusalDetailsSchema,
  type IdempotencyKey,
  type StepDefinition,
  type StepExecutionId,
} from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockGetSessionStateSafe = vi.fn();
const mockGetSessionState = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getRunAccessGrant: vi.fn(() => Promise.resolve(null)),
  updateSessionState: vi.fn(),
  atomicCompleteStep: vi.fn(),
}));

const mockCreatePlanNode = vi.fn();
const mockUpdatePlanNode = vi.fn();
const mockGetPlanNode = vi.fn();
const mockListPlanNodes = vi.fn();
const mockLinkPlanNode = vi.fn();
const mockNextInPlanStream = vi.fn();
const mockNextOnPlanBoard = vi.fn();
const mockLearnOnPlanNode = vi.fn();
const mockDependPlanNode = vi.fn();
const STORE = { kind: 'store' };
const READS = { kind: 'reads' };
vi.mock('@aflow/cybernetic-runtime', () => ({
  createPlanNodeStore: () => STORE,
  learnOnPlanNode: (...a: unknown[]) => mockLearnOnPlanNode(...a),
  dependPlanNode: (...a: unknown[]) => mockDependPlanNode(...a),
  createPlanNode: (...a: unknown[]) => mockCreatePlanNode(...a),
  updatePlanNode: (...a: unknown[]) => mockUpdatePlanNode(...a),
  getPlanNode: (...a: unknown[]) => mockGetPlanNode(...a),
  listPlanNodes: (...a: unknown[]) => mockListPlanNodes(...a),
  linkPlanNode: (...a: unknown[]) => mockLinkPlanNode(...a),
  createPlanStreamReads: () => READS,
  nextInPlanStream: (...a: unknown[]) => mockNextInPlanStream(...a),
  nextOnPlanBoard: (...a: unknown[]) => mockNextOnPlanBoard(...a),
}));
vi.mock('@aflow/database', () => ({ getDatabase: () => ({}) }));
const mockReadDurableSessionCreatedBy = vi.fn();
vi.mock('../../../../cybernetic/harness/helpers.js', () => ({
  readDurableSessionCreatedBy: (...a: unknown[]) => mockReadDurableSessionCreatedBy(...a),
}));

import { handlePlanNodeInline } from '../plan/index.js';
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const NODE_ID = '00000000-0000-4000-8000-0000000003a2';
const SESSION = 'session-helmsman-2';
const OPERATOR = 'b0000000-0000-4000-8000-0000000000aa';

const NODE = {
  nodeId: NODE_ID,
  spaceId: SPACE,
  parentId: null,
  kind: 'execute',
  title: '315 · Local first-run ergonomics',
  goal: 'g',
  criteria: 'c',
  status: 'active',
  note: 'next: F114 findings out of the plan file',
  revision: 2,
  position: 0,
  createdAt: '2026-10-04T09:00:00.000Z',
  updatedAt: '2026-10-04T09:05:00.000Z',
};

const LINK = {
  nodeId: NODE_ID,
  kind: 'pull_request',
  ref: 'https://github.com/aflowai/aflow/pull/80',
  createdAt: '2026-10-05T09:00:00.000Z',
};

const REFUSAL_DETAILS = {
  nodeId: NODE.nodeId,
  revision: NODE.revision,
  status: NODE.status,
  updatedAt: NODE.updatedAt,
};

function makeArgs(operation: string, input: unknown): InlineHandlerArgs {
  return {
    redis: { kind: 'redis' } as never,
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve(input)),
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
    } as never,
    context: { tenantId: TENANT, runId: SESSION, traceId: 'trace-plan', spaceId: SPACE } as never,
    stepDef: { stepId: 'plan', stepType: 'plan', operation } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 0,
  };
}

function emitted(): Record<string, unknown> {
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

/** A small output travels inline on the step result, base64 after `inline:`. */
function emittedOutput(): unknown {
  const ref = emitted()['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { createdBy: OPERATOR } });
  mockReadDurableSessionCreatedBy.mockResolvedValue(undefined);
});

describe('plan.node.update', () => {
  it('surfaces a stale write as a validation error carrying what a retry needs, not the node', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'Plan node is at revision 2; nothing was written.',
      details: { ...REFUSAL_DETAILS, differingFields: ['note'] },
    });

    await handlePlanNodeInline(
      makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 1, note: 'mine' }),
    );

    const msg = emitted();
    expect(msg['status']).toBe('FAILED');
    expect(msg['error']).toMatchObject({
      code: 'PLAN_NODE_STALE',
      classification: 'validation',
      retryable: false,
    });
    const error = msg['error'] as { details: unknown };
    expect(PlanNodeRefusalDetailsSchema.parse(error.details)).toEqual({
      ...REFUSAL_DETAILS,
      differingFields: ['note'],
    });
  });

  it('surfaces an update that changes nothing as a non-retryable validation error carrying what a retry needs', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message: 'Plan node already stands as this update would leave it, so nothing was written.',
      details: { ...REFUSAL_DETAILS, differingFields: [] },
    });

    await handlePlanNodeInline(
      makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 2, note: NODE.note }),
    );

    const msg = emitted();
    expect(msg['status']).toBe('FAILED');
    expect(msg['error']).toMatchObject({
      code: 'PLAN_NODE_UNCHANGED',
      classification: 'validation',
      retryable: false,
    });
    const error = msg['error'] as { details: unknown };
    expect(PlanNodeRefusalDetailsSchema.parse(error.details)).toEqual({
      ...REFUSAL_DETAILS,
      differingFields: [],
    });
  });

  it('surfaces an unknown node as a validation error', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'No plan node in this space.',
      details: { nodeId: NODE_ID },
    });
    await handlePlanNodeInline(
      makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 1, note: 'x' }),
    );
    expect(emitted()['error']).toMatchObject({
      code: 'PLAN_NODE_NOT_FOUND',
      classification: 'validation',
    });
  });

  it('refuses done without an outcome before the engine is reached, and teaches why', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 2, status: 'done' }),
    );
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
    const error = emitted()['error'] as { code: string; message: string; classification: string };
    expect(error.code).toBe('PLAN_NODE_INVALID_INPUT');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain(PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE);
  });

  it.each(['waiting', 'active'] as const)(
    'keeps Helmsman %s writes outside human authority',
    async (status) => {
      mockUpdatePlanNode.mockResolvedValue({ ok: true, node: { ...NODE, revision: 3 } });
      await handlePlanNodeInline(
        makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 2, status }),
      );
      expect(mockUpdatePlanNode).toHaveBeenCalledWith(
        {
          store: STORE,
          spaceId: SPACE,
          redis: { kind: 'redis' },
          tenantId: TENANT,
          actorKind: 'agent',
        },
        { nodeId: NODE_ID, expectedRevision: 2, status },
      );
      expect(emitted()['status']).toBe('SUCCEEDED');
    },
  );
});

describe('plan.node.create / get / list', () => {
  it('creates through the engine as the user behind the session', async () => {
    mockCreatePlanNode.mockResolvedValue({ ok: true, node: NODE });
    await handlePlanNodeInline(
      makeArgs('plan.node.create', { kind: 'execute', title: 't', goal: 'g', criteria: 'c' }),
    );
    expect(mockGetSessionStateSafe).toHaveBeenCalledWith({ kind: 'redis' }, TENANT, SESSION);
    expect(mockCreatePlanNode.mock.calls[0]![0]).toMatchObject({
      createdBy: OPERATOR,
      spaceId: SPACE,
    });
    expect(emitted()['status']).toBe('SUCCEEDED');
  });

  it('reads the user from the durable session once hot state is gone', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: false });
    mockReadDurableSessionCreatedBy.mockResolvedValue(OPERATOR);
    mockCreatePlanNode.mockResolvedValue({ ok: true, node: NODE });
    await handlePlanNodeInline(
      makeArgs('plan.node.create', { kind: 'execute', title: 't', goal: 'g', criteria: 'c' }),
    );
    expect(mockCreatePlanNode.mock.calls[0]![0]).toMatchObject({ createdBy: OPERATOR });
  });

  it('opens a node with its children, links and runs in flight', async () => {
    mockGetPlanNode.mockResolvedValue({
      ok: true,
      node: NODE,
      children: [],
      childrenTotal: 0,
      links: [LINK],
      linksTotal: 1,
      runs: [],
      runsTotal: 0,
    });
    await handlePlanNodeInline(makeArgs('plan.node.get', { nodeId: NODE_ID }));
    expect(mockGetPlanNode).toHaveBeenCalledWith({ store: STORE, spaceId: SPACE }, NODE_ID);
    expect(emitted()['status']).toBe('SUCCEEDED');
    expect(emittedOutput()).toMatchObject({ links: [LINK], linksTotal: 1, runsTotal: 0 });
  });

  it('lists with the schema’s defaults applied', async () => {
    mockListPlanNodes.mockResolvedValue({ ok: true, nodes: [] });
    await handlePlanNodeInline(makeArgs('plan.node.list', {}));
    expect(mockListPlanNodes.mock.calls[0]![1]).toMatchObject({
      status: ['active', 'waiting', 'blocked'],
    });
    expect(emitted()['status']).toBe('SUCCEEDED');
  });

  it('turns an engine failure into an internal error that says not to retry', async () => {
    mockGetPlanNode.mockRejectedValue(new Error('connection reset'));
    await handlePlanNodeInline(makeArgs('plan.node.get', { nodeId: NODE_ID }));
    expect(emitted()['error']).toMatchObject({
      code: 'PLAN_OPERATION_FAILED',
      classification: 'internal',
    });
  });
});

describe('plan.node.link', () => {
  it('links through the engine in this space', async () => {
    mockLinkPlanNode.mockResolvedValue({ ok: true, link: LINK });
    await handlePlanNodeInline(
      makeArgs('plan.node.link', { nodeId: NODE_ID, kind: 'pull_request', ref: LINK.ref }),
    );
    expect(mockLinkPlanNode).toHaveBeenCalledWith(
      {
        store: STORE,
        spaceId: SPACE,
        redis: { kind: 'redis' },
        tenantId: TENANT,
        actorKind: 'agent',
      },
      { nodeId: NODE_ID, kind: 'pull_request', ref: LINK.ref },
    );
    expect(emitted()['status']).toBe('SUCCEEDED');
    expect(emittedOutput()).toEqual({ link: LINK });
  });

  it('surfaces a node that does not exist as a validation error naming it', async () => {
    mockLinkPlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'No plan node in this space.',
      details: { nodeId: NODE_ID },
    });
    await handlePlanNodeInline(
      makeArgs('plan.node.link', { nodeId: NODE_ID, kind: 'finding', ref: 'F114' }),
    );
    expect(emitted()['error']).toMatchObject({
      code: 'PLAN_NODE_NOT_FOUND',
      classification: 'validation',
      retryable: false,
      details: { nodeId: NODE_ID },
    });
  });

  it('refuses a pull request that is not a URL before the engine is reached', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.link', { nodeId: NODE_ID, kind: 'pull_request', ref: '#80' }),
    );
    expect(mockLinkPlanNode).not.toHaveBeenCalled();
    expect(emitted()['error']).toMatchObject({ code: 'PLAN_NODE_INVALID_INPUT' });
  });
});

describe('plan.node.learn (Plan 322 P2)', () => {
  const LEARNING = {
    nodeId: NODE_ID,
    kind: 'constraint',
    statement: 'The integration suite needs a migrated database.',
    evidence: { citations: [{ runId: '00000000-0000-4000-8000-0000000000a1' }] },
    confidence: 'medium',
  };

  it('records the learning through the engine as written by this session', async () => {
    const learning = {
      learningId: '00000000-0000-4000-8000-0000000000b1',
      nodeId: NODE_ID,
      kind: 'constraint',
      statement: LEARNING.statement,
      confidence: 'medium',
      runIds: [LEARNING.evidence.citations[0]!.runId],
      createdAt: '2026-10-23T09:00:00.000Z',
    };
    mockLearnOnPlanNode.mockResolvedValue({ ok: true, learning, superseded: [] });
    await handlePlanNodeInline(makeArgs('plan.node.learn', LEARNING));
    expect(mockLearnOnPlanNode).toHaveBeenCalledWith(
      {
        store: STORE,
        spaceId: SPACE,
        redis: { kind: 'redis' },
        tenantId: TENANT,
        actorKind: 'agent',
      },
      LEARNING,
      { sessionId: SESSION },
    );
    expect(emitted()['status']).toBe('SUCCEEDED');
    expect(emittedOutput()).toEqual({ learning, superseded: [] });
  });

  it('refuses a learning that cites no run before the engine is reached', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.learn', { ...LEARNING, evidence: { citations: [] } }),
    );
    expect(mockLearnOnPlanNode).not.toHaveBeenCalled();
    expect(emitted()['error']).toMatchObject({ code: 'PLAN_NODE_INVALID_INPUT' });
  });

  it('a later session opening the node is handed its learnings and dependencies', async () => {
    const read = {
      ok: true,
      node: NODE,
      children: [],
      childrenTotal: 0,
      links: [],
      linksTotal: 0,
      runs: [],
      runsTotal: 0,
      dependencies: [
        { nodeId: NODE_ID, title: 'Land the read', status: 'done', condition: 'done', met: true },
      ],
      dependenciesTotal: 1,
      dependents: [],
      dependentsTotal: 0,
      learnings: [{ learningId: 'l', nodeId: NODE_ID, statement: LEARNING.statement }],
      learningsTotal: 1,
    };
    mockGetPlanNode.mockResolvedValue(read);
    await handlePlanNodeInline({
      ...makeArgs('plan.node.get', { nodeId: NODE_ID }),
      context: { tenantId: TENANT, runId: 'session-helmsman-3', spaceId: SPACE } as never,
    });
    expect(emittedOutput()).toMatchObject({
      dependencies: read.dependencies,
      dependenciesTotal: 1,
      learnings: read.learnings,
      learningsTotal: 1,
    });
  });
});

describe('plan.node.depend (Plan 322 P2)', () => {
  const OTHER = '00000000-0000-4000-8000-0000000003a3';

  it('writes the edge through the engine, compare-and-set on the waiting node', async () => {
    const dependency = {
      nodeId: NODE_ID,
      dependsOnId: OTHER,
      condition: 'done',
      createdAt: '2026-10-23T09:00:00.000Z',
    };
    mockDependPlanNode.mockResolvedValue({
      ok: true,
      node: { ...NODE, revision: 3 },
      dependency,
    });
    const input = { nodeId: NODE_ID, expectedRevision: 2, dependsOnId: OTHER, condition: 'done' };
    await handlePlanNodeInline(makeArgs('plan.node.depend', input));
    expect(mockDependPlanNode.mock.calls[0]![1]).toEqual(input);
    expect(emittedOutput()).toEqual({ node: { ...NODE, revision: 3 }, dependency });
  });

  it('surfaces a cycle as a validation error naming the loop', async () => {
    mockDependPlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
      message: 'cannot wait on it: it closes a loop.',
      details: { nodeId: NODE_ID, dependsOnId: OTHER, path: [NODE_ID, OTHER, NODE_ID] },
    });
    await handlePlanNodeInline(
      makeArgs('plan.node.depend', {
        nodeId: NODE_ID,
        expectedRevision: 2,
        dependsOnId: OTHER,
        condition: 'closed',
      }),
    );
    expect(emitted()['error']).toMatchObject({
      code: 'PLAN_NODE_DEPENDENCY_CYCLE',
      classification: 'validation',
      retryable: false,
      details: { path: [NODE_ID, OTHER, NODE_ID] },
    });
  });

  it('refuses a write naming neither a condition nor a removal before the engine is reached', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.depend', { nodeId: NODE_ID, expectedRevision: 2, dependsOnId: OTHER }),
    );
    expect(mockDependPlanNode).not.toHaveBeenCalled();
    expect(emitted()['error']).toMatchObject({ code: 'PLAN_NODE_INVALID_INPUT' });
  });
});

describe('plan.node.next', () => {
  it('decides through the engine in this space, with the stream reads, the budget defaulted', async () => {
    const decision = {
      decision: 'wait',
      cause: 'in_flight',
      reason: 'Work for the node is in flight.',
    };
    mockNextInPlanStream.mockResolvedValue({ ok: true, output: decision });
    await handlePlanNodeInline(makeArgs('plan.node.next', { rootNodeId: NODE_ID }));
    expect(mockNextInPlanStream).toHaveBeenCalledWith(
      {
        store: STORE,
        spaceId: SPACE,
        reads: READS,
        redis: { kind: 'redis' },
        tenantId: TENANT,
        holder: SESSION,
      },
      NODE_ID,
      {
        rootNodeId: NODE_ID,
        attempts: PLAN_STREAM_ATTEMPTS_DEFAULT,
        decisions: PLAN_BOARD_DECISIONS_DEFAULT,
      },
    );
    expect(mockNextOnPlanBoard).not.toHaveBeenCalled();
    expect(emitted()['status']).toBe('SUCCEEDED');
    expect(emittedOutput()).toEqual(decision);
  });

  it('with no root, decides the whole board — the resident’s wake', async () => {
    const board = { scope: 'board', decisions: [], deferred: 0, waits: [], roots: 2 };
    mockNextOnPlanBoard.mockResolvedValue({ ok: true, output: board });
    mockGetSessionState.mockResolvedValue(null);
    await handlePlanNodeInline(makeArgs('plan.node.next', {}));
    expect(mockNextOnPlanBoard).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: SPACE, holder: SESSION }),
      {
        attempts: PLAN_STREAM_ATTEMPTS_DEFAULT,
        decisions: PLAN_BOARD_DECISIONS_DEFAULT,
      },
    );
    expect(mockNextInPlanStream).not.toHaveBeenCalled();
    expect(emittedOutput()).toEqual(board);
  });

  it('refuses a pull request answer with no root to answer it for', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.next', { pullRequest: { url: LINK.ref, read: 'failed' } }),
    );
    expect(mockNextOnPlanBoard).not.toHaveBeenCalled();
    expect(emitted()['error']).toMatchObject({ code: 'PLAN_NODE_INVALID_INPUT' });
  });

  it('refuses a pull request answer that omits what a merge needs before the engine is reached', async () => {
    await handlePlanNodeInline(
      makeArgs('plan.node.next', {
        rootNodeId: NODE_ID,
        pullRequest: { url: LINK.ref, read: 'ok', state: 'closed', merged: true },
      }),
    );
    expect(mockNextInPlanStream).not.toHaveBeenCalled();
    expect(emitted()['error']).toMatchObject({ code: 'PLAN_NODE_INVALID_INPUT' });
  });

  it('surfaces a root that is not in the space as a validation error naming it', async () => {
    mockNextInPlanStream.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'No plan node in this space.',
      details: { nodeId: NODE_ID },
    });
    await handlePlanNodeInline(makeArgs('plan.node.next', { rootNodeId: NODE_ID }));
    expect(emitted()['error']).toMatchObject({
      code: 'PLAN_NODE_NOT_FOUND',
      classification: 'validation',
      details: { nodeId: NODE_ID },
    });
  });
});
