import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
  resolveWorkflowForRunRevision: vi.fn(),
  workflowRuns: { __token: 'workflow_runs' },
  workflowRunTasks: { __token: 'workflow_run_tasks' },
}));

vi.mock('drizzle-orm', () => ({
  and: (..._args: unknown[]) => ({ __op: 'and' }),
  desc: (..._args: unknown[]) => ({ __op: 'desc' }),
  eq: (..._args: unknown[]) => ({ __op: 'eq' }),
}));

const cyberneticMocks = vi.hoisted(() => ({
  loadWorkflowHumanTaskHydration: vi.fn(),
  buildHumanTaskHydrationFields: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadWorkflowHumanTaskHydration: cyberneticMocks.loadWorkflowHumanTaskHydration,
  buildHumanTaskHydrationFields: cyberneticMocks.buildHumanTaskHydrationFields,
}));

import { createWorkflowHumanTaskSource } from '../sources/workflowHumanTaskSource.js';
import { withTenantSchema, resolveWorkflowForRunRevision } from '@aflow/database';
import { ActionCenterResolveError, type ActionCenterContext } from '../types.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '00000000-0000-0000-0000-000000000010';
const SESSION_ID = '00000000-0000-0000-0000-000000000020';

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: '00000000-0000-0000-0000-000000000004',
    actorSpaceRole: 'admin',
    actorIsTenantAdmin: true,
  };
}

function joinedRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run: {
      runId: RUN_ID,
      spaceId: SPACE_ID,
      workflowSlug: 'kaggle-competition-optimizer',
      workflowRevision: 1,
      status: 'paused',
      pauseVersion: 3,
      sessionId: SESSION_ID,
      startedAt: new Date('2026-05-30T12:00:00.000Z'),
      ...((overrides['run'] as object) ?? {}),
    },
    task: {
      taskId: 'approve-submit',
      runId: RUN_ID,
      status: 'paused',
      startedAt: new Date('2026-05-30T12:05:00.000Z'),
      ...((overrides['task'] as object) ?? {}),
    },
  };
}

function humanApproveTaskDef(taskId = 'approve-submit') {
  return {
    taskId,
    name: 'Approve Kaggle submission',
    type: 'human',
    intent: 'approve',
    pauseInstruction: 'Review the submission below.',
  };
}

function makeSource() {
  return createWorkflowHumanTaskSource({
    db: {} as never,
    redis: {} as never,
    payloadStore: {} as never,
  });
}

beforeEach(() => {
  vi.mocked(withTenantSchema).mockReset();
  vi.mocked(resolveWorkflowForRunRevision).mockReset();
  cyberneticMocks.loadWorkflowHumanTaskHydration.mockReset();
  cyberneticMocks.buildHumanTaskHydrationFields.mockReset();
  // Default: no durable ref (pre-Plan-170 row). Tests that exercise the
  // durable path override this with a `hydrated` result.
  cyberneticMocks.loadWorkflowHumanTaskHydration.mockResolvedValue({
    kind: 'missing',
    diagnostic: {},
  });
  cyberneticMocks.buildHumanTaskHydrationFields.mockImplementation(
    (args: { task: { outputContract?: { schema?: Record<string, unknown> } } }) => {
      const schema = args.task.outputContract?.schema;
      return schema ? { resolutionSchema: schema } : undefined;
    },
  );
});

describe('workflowHumanTaskSource — listOpen', () => {
  it('returns paused human-task items in scope', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([joinedRow()]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: { tasks: [humanApproveTaskDef()] },
    } as never);

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.id).toBe(`workflow-task:${RUN_ID}:approve-submit`);
    expect(it.kind).toBe('human_approval');
    // Same kinds are resolvable from a paused step; this one is answered in
    // chat, so the card must stay read-only for every reader.
    expect(projectActionCenterItem(ctx(), it).allowedActions).toEqual([]);
    expect(it.origin).toEqual({
      type: 'workflow_task',
      runId: RUN_ID,
      taskId: 'approve-submit',
      pauseVersion: 3,
    });
    expect(it.summary).toContain('view-only');
    expect(it.requestedBy.sessionId).toBe(SESSION_ID);
  });

  it('excludes tasks that are not type human in the workflow def', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([joinedRow()]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: {
        tasks: [{ taskId: 'approve-submit', name: 'X', type: 'agent', agent: 'runner' }],
      },
    } as never);

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(0);
  });

  it('maps collect intent to human_input kind', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([
      joinedRow({ task: { taskId: 'gather-input' } }),
    ]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: {
        tasks: [
          {
            taskId: 'gather-input',
            name: 'Gather input',
            type: 'human',
            intent: 'collect',
            pauseInstruction: 'Provide details.',
            outputContract: { schema: { type: 'object' } },
          },
        ],
      },
    } as never);

    const items = await makeSource().listOpen(ctx());
    expect(items[0]?.kind).toBe('human_input');
    expect(items[0]?.resolutionSchema).toEqual({ type: 'object' });
  });

  it('surfaces paused row using durable hydration when the workflow definition has drifted', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([joinedRow()]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: { tasks: [] }, // taskId no longer present
    } as never);
    cyberneticMocks.loadWorkflowHumanTaskHydration.mockResolvedValueOnce({
      kind: 'hydrated',
      hydration: {
        hydrationVersion: 1,
        runId: RUN_ID,
        taskId: 'approve-submit',
        attempt: 1,
        pauseVersion: 3,
        humanIntent: 'approve',
        resolutionSchema: { type: 'object', properties: { decision: { type: 'string' } } },
        resumeContract: {} as never,
        createdAt: '2026-05-30T12:00:00.000Z',
      },
    });

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.kind).toBe('human_approval');
    expect(it.title).toBe('approve-submit'); // taskId fallback
    expect(it.resolutionSchema).toEqual({
      type: 'object',
      properties: { decision: { type: 'string' } },
    });
  });

  it('still drops the row when both taskDef and durable hydration are absent', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([joinedRow()]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: { tasks: [] },
    } as never);
    // default mock returns { kind: 'missing' }

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(0);
  });
});

describe('workflowHumanTaskSource — getById', () => {
  it('returns null for ids without the workflow-task prefix', async () => {
    const item = await makeSource().getById(ctx(), `proposal:${RUN_ID}`);
    expect(item).toBeNull();
    expect(withTenantSchema).not.toHaveBeenCalled();
  });

  it('returns the item when found', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([joinedRow()]);
    vi.mocked(resolveWorkflowForRunRevision).mockResolvedValueOnce({
      workflow: { tasks: [humanApproveTaskDef()] },
    } as never);

    const item = await makeSource().getById(ctx(), `workflow-task:${RUN_ID}:approve-submit`);
    expect(item?.id).toBe(`workflow-task:${RUN_ID}:approve-submit`);
  });

  it('returns null when no row matches', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([]);
    const item = await makeSource().getById(ctx(), `workflow-task:${RUN_ID}:approve-submit`);
    expect(item).toBeNull();
  });
});

describe('workflowHumanTaskSource — resolve', () => {
  it('throws INVALID_RESOLUTION with run-surface message', async () => {
    const src = makeSource();
    await expect(
      src.resolve(ctx(), {} as never, { kind: 'approve' } as never),
    ).rejects.toMatchObject({
      code: 'INVALID_RESOLUTION',
      message: expect.stringContaining('run surface'),
    });
    await expect(
      src.resolve(ctx(), {} as never, { kind: 'submit' } as never),
    ).rejects.toBeInstanceOf(ActionCenterResolveError);
  });
});
