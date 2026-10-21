/**
 * A write approval raised by an operation task inside a workflow run pauses the
 * RUN and creates no session, so the step plane never sees it. This source
 * surfaces it as the same approve/deny card, and its resolve is the
 * authenticated boundary that answers it (Plan 253).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionCenterItemSchema,
  type ApiWriteApprovalRequestPayload,
  type TenantId,
} from '@aflow/schemas';

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  sessions: {},
  workflowRuns: {},
  workflowRunTasks: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
}));

const cybernetic = vi.hoisted(() => ({
  readPausedTaskWriteApproval: vi.fn(),
  resolvePausedRunWriteApproval: vi.fn(),
  enqueueWorkflowHarnessAdvance: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  readPausedTaskWriteApproval: cybernetic.readPausedTaskWriteApproval,
  resolvePausedRunWriteApproval: cybernetic.resolvePausedRunWriteApproval,
  enqueueWorkflowHarnessAdvance: cybernetic.enqueueWorkflowHarnessAdvance,
  executeOperatorWorkflowRunResume: vi.fn(),
}));

import { createWorkflowWriteApprovalSource } from '../sources/workflowWriteApprovalSource.js';
import { ActionCenterResolveError, type ActionCenterContext } from '../types.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '0013314a-0000-4000-8000-000000000162';
const SESSION = '00000000-0000-4000-8000-000000000020';
const OPERATOR = '00000000-0000-4000-8000-0000000000aa';
const PAYLOAD_REF = 'payload:write-approval';
const ITEM_ID = `workflow-write-approval:${RUN_ID}:3`;

const MERGE_REQUEST: ApiWriteApprovalRequestPayload = {
  kind: 'write_approval',
  target: 'api',
  apiId: 'github',
  endpointId: 'mergePullRequest',
  endpointName: 'Merge a pull request',
  method: 'PUT',
  urlHost: 'api.github.com',
  writeRiskTier: 'medium',
  bodyPreview: '{"merge_method":"squash","sha":"a392f680"}',
  requestHash: '86b46923aa',
};

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId: OPERATOR,
    actorSpaceRole: 'editor',
    actorIsTenantAdmin: false,
  };
}

function pausedMerge() {
  return {
    run: {
      runId: RUN_ID,
      spaceId: SPACE,
      workflowSlug: 'local-pr-shepherd',
      status: 'paused',
      pausedReason: 'task_paused',
      pausedPayloadRef: PAYLOAD_REF,
      pauseVersion: 3,
      sessionId: SESSION,
      startedAt: new Date('2026-10-21T09:00:00.000Z'),
    },
    task: {
      runId: RUN_ID,
      taskId: 'merge',
      status: 'paused',
      attempt: 1,
      outputRef: PAYLOAD_REF,
      completedAt: new Date('2026-10-21T09:05:00.000Z'),
    },
  };
}

function makeSource() {
  return createWorkflowWriteApprovalSource({
    db: {} as never,
    redis: {} as never,
    payloadStore: {} as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithTenantSchema.mockResolvedValue([pausedMerge()]);
  cybernetic.readPausedTaskWriteApproval.mockResolvedValue(MERGE_REQUEST);
  cybernetic.resolvePausedRunWriteApproval.mockResolvedValue({ ok: true, request: MERGE_REQUEST });
});

describe('workflowWriteApprovalSource — the card', () => {
  it("lists a run paused on its operation task's write approval as an approve/deny card", async () => {
    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const item = items[0]!;

    expect(item.id).toBe(ITEM_ID);
    expect(item.kind).toBe('write_approval');
    expect(item.status).toBe('open');
    expect(item.origin).toEqual({
      type: 'workflow_task',
      runId: RUN_ID,
      taskId: 'merge',
      pauseVersion: 3,
    });
    // The same card the step plane builds for this request.
    expect(item.title).toBe('Approve write: Merge a pull request');
    expect(item.summary).toContain('PUT api.github.com (github/mergePullRequest)');
    expect(item.extension).toEqual({
      kind: 'write_approval',
      target: 'api',
      apiId: 'github',
      endpointId: 'mergePullRequest',
      endpointName: 'Merge a pull request',
      method: 'PUT',
      urlHost: 'api.github.com',
      writeRiskTier: 'medium',
      bodyPreview: '{"merge_method":"squash","sha":"a392f680"}',
    });
    expect(item.requestedAt).toBe('2026-10-21T09:05:00.000Z');
    expect(item.requestedBy).toEqual({
      kind: 'workflow',
      label: 'Workflow: local-pr-shepherd',
      sessionId: SESSION,
    });
    expect(item.relatesTo).toEqual([
      { kind: 'binding', id: 'github', label: 'github' },
      { kind: 'workflow', id: 'local-pr-shepherd', label: 'local-pr-shepherd' },
    ]);

    const projected = projectActionCenterItem(ctx(), item);
    expect(projected.allowedActions).toEqual(['approve', 'reject', 'reassign']);
    expect(ActionCenterItemSchema.safeParse(projected).success).toBe(true);
  });

  it('reads the request from the run and the task that holds its pause', async () => {
    await makeSource().listOpen(ctx());
    const { run, task } = pausedMerge();
    expect(cybernetic.readPausedTaskWriteApproval).toHaveBeenCalledWith(
      expect.anything(),
      run,
      task,
    );
  });

  it('lists nothing for a task pause that is not a write approval', async () => {
    cybernetic.readPausedTaskWriteApproval.mockResolvedValueOnce(null);
    await expect(makeSource().listOpen(ctx())).resolves.toEqual([]);
  });
});

describe('workflowWriteApprovalSource — getById', () => {
  it('ignores ids of other sources and malformed ids without reading', async () => {
    const src = makeSource();
    await expect(src.getById(ctx(), `workflow-task:${RUN_ID}:merge`)).resolves.toBeNull();
    await expect(src.getById(ctx(), `workflow-write-approval:${RUN_ID}`)).resolves.toBeNull();
    await expect(src.getById(ctx(), `workflow-write-approval:${RUN_ID}:x`)).resolves.toBeNull();
    expect(mockWithTenantSchema).not.toHaveBeenCalled();
  });

  it('finds the item while the run is still paused at that version', async () => {
    const item = await makeSource().getById(ctx(), ITEM_ID);
    expect(item?.id).toBe(ITEM_ID);
  });

  it('finds nothing once the run has moved past that pause', async () => {
    mockWithTenantSchema.mockResolvedValueOnce([]);
    await expect(makeSource().getById(ctx(), ITEM_ID)).resolves.toBeNull();
  });
});

describe('workflowWriteApprovalSource — resolve', () => {
  async function item() {
    const [listed] = await makeSource().listOpen(ctx());
    return listed!;
  }

  it('answers an approval as the authenticated operator, for the pause on the card', async () => {
    const outcome = await makeSource().resolve(ctx(), await item(), {
      kind: 'approve',
      comment: 'ship it',
    });

    expect(cybernetic.resolvePausedRunWriteApproval).toHaveBeenCalledTimes(1);
    const [, decision] = cybernetic.resolvePausedRunWriteApproval.mock.calls[0]!;
    expect(decision).toEqual({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN_ID,
      taskId: 'merge',
      pauseVersion: 3,
      actorUserId: OPERATOR,
      decision: 'approved',
      reason: 'ship it',
    });
    expect(outcome.dispatchedOperationId).toBe('workflow.run.resume');
    expect(outcome.reportedOperationId).toBe('api.http.call');
  });

  it("answers a denial with the operator's reason", async () => {
    await makeSource().resolve(ctx(), await item(), { kind: 'reject', reason: 'not this head' });
    const [, decision] = cybernetic.resolvePausedRunWriteApproval.mock.calls[0]!;
    expect(decision).toMatchObject({ decision: 'denied', reason: 'not this head' });
  });

  it('hands the run back through the harness-advance stream, re-dispatching the task on approve', async () => {
    await makeSource().resolve(ctx(), await item(), { kind: 'approve' });
    const [, , hooks] = cybernetic.resolvePausedRunWriteApproval.mock.calls[0]!;
    await hooks.dispatchRetriedTask({}, TENANT, RUN_ID, 'merge');
    await hooks.applyFailureMode({}, TENANT, RUN_ID, 'merge');
    expect(cybernetic.enqueueWorkflowHarnessAdvance).toHaveBeenNthCalledWith(1, expect.anything(), {
      tenantId: TENANT,
      workflowRunId: RUN_ID,
      spaceId: SPACE,
      action: 'retry_dispatch',
      taskId: 'merge',
    });
    expect(cybernetic.enqueueWorkflowHarnessAdvance).toHaveBeenNthCalledWith(2, expect.anything(), {
      tenantId: TENANT,
      workflowRunId: RUN_ID,
      spaceId: SPACE,
      failedTaskId: 'merge',
    });
  });

  it('refuses anything but approve or deny', async () => {
    await expect(
      makeSource().resolve(ctx(), await item(), { kind: 'dismiss' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    expect(cybernetic.resolvePausedRunWriteApproval).not.toHaveBeenCalled();
  });

  it('reports a pause that moved on as a stale item', async () => {
    cybernetic.resolvePausedRunWriteApproval.mockResolvedValueOnce({
      ok: false,
      code: 'STALE_PAUSE',
      message: 'gone',
    });
    const err = await makeSource()
      .resolve(ctx(), await item(), { kind: 'approve' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect(err).toMatchObject({ code: 'STALE_ACTION_CENTER_ITEM', severity: 'stale_target' });
  });

  it('reports a decision that could not be recorded as worth retrying', async () => {
    cybernetic.resolvePausedRunWriteApproval.mockResolvedValueOnce({
      ok: false,
      code: 'GRANT_NOT_WRITTEN',
      message: 'redis down',
    });
    await expect(
      makeSource().resolve(ctx(), await item(), { kind: 'approve' }),
    ).rejects.toMatchObject({ code: 'DISPATCH_FAILED', severity: 'transient' });
  });
});
