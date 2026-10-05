/**
 * plan.node.* inline ops (Plan 322) — thin adapters over the plan engine:
 * input parsed with its refinement, the engine's refusals surfaced as
 * validation errors carrying their details, the writing session recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
  PlanNodeRefusalDetailsSchema,
  type IdempotencyKey,
  type StepDefinition,
  type StepExecutionId,
} from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockGetSessionStateSafe = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  atomicCompleteStep: vi.fn(),
}));

const mockCreatePlanNode = vi.fn();
const mockUpdatePlanNode = vi.fn();
const mockGetPlanNode = vi.fn();
const mockListPlanNodes = vi.fn();
const mockLinkPlanNode = vi.fn();
const STORE = { kind: 'store' };
vi.mock('@aflow/cybernetic-runtime', () => ({
  createPlanNodeStore: () => STORE,
  createPlanNode: (...a: unknown[]) => mockCreatePlanNode(...a),
  updatePlanNode: (...a: unknown[]) => mockUpdatePlanNode(...a),
  getPlanNode: (...a: unknown[]) => mockGetPlanNode(...a),
  listPlanNodes: (...a: unknown[]) => mockListPlanNodes(...a),
  linkPlanNode: (...a: unknown[]) => mockLinkPlanNode(...a),
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

  it('writes through the engine in this space, with the attention cache’s redis', async () => {
    mockUpdatePlanNode.mockResolvedValue({ ok: true, node: { ...NODE, revision: 3 } });
    await handlePlanNodeInline(
      makeArgs('plan.node.update', { nodeId: NODE_ID, expectedRevision: 2, status: 'waiting' }),
    );
    expect(mockUpdatePlanNode).toHaveBeenCalledWith(
      { store: STORE, spaceId: SPACE, redis: { kind: 'redis' }, tenantId: TENANT },
      { nodeId: NODE_ID, expectedRevision: 2, status: 'waiting' },
    );
    expect(emitted()['status']).toBe('SUCCEEDED');
  });
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
      { store: STORE, spaceId: SPACE, redis: { kind: 'redis' }, tenantId: TENANT },
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
