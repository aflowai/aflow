/**
 * A workflow a conversation started with workflow.run.start runs each task as
 * the conversation is when the task is dispatched: each Runner session is
 * queued holding the anchor's activatedByPerson, and each operation task's job
 * carries it — through a timer too, which has no session to read it from. The
 * same conversation last woken by a schedule dispatches unattended tasks.
 */
import type { SessionHotState } from '@aflow/redis';
import type { PayloadRef, SessionId, TenantId, TimerItem, TraceId } from '@aflow/schemas';
import { SNOOZE_OPERATION_ID } from '@aflow/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockSetSessionState = vi.fn();
const mockAddControlMessage = vi.fn();
const mockAddStepJob = vi.fn();
const mockScheduleShardTimer = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
  scheduleShardTimer: (...args: unknown[]) => mockScheduleShardTimer(...args),
  appendSessionEvent: vi.fn(async () => undefined),
  markSessionDirty: vi.fn(async () => undefined),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTenantSchema: vi.fn(async () => []),
}));

vi.mock('../helpers.js', () => ({
  readDurableSessionCreatedBy: vi.fn(async () => undefined),
}));

vi.mock('../dispatch.js', () => ({ onWorkflowTaskComplete: vi.fn() }));
vi.mock('../validateRunnerOutputContract.js', () => ({
  validateRunnerOutputContractAtHarness: vi.fn(),
}));

const { spawnRunnerSession } = await import('../runnerBridge.js');
const { resolveWorkflowTaskAuthority } = await import('../taskAuthority.js');
const { dispatchClaimedOperationTask } = await import('../operationTaskDispatch.js');
const { buildWorkflowTimerStepJob } =
  await import('../../../SessionOrchestrator/scheduling/workflowTimerJob.js');

const TENANT = 'a0000000-0000-0000-0000-0000000000e1' as TenantId;
const SPACE = '00000000-0000-0000-0000-0000000000e2';
const ANCHOR = '00000000-0000-0000-0000-0000000000e3' as SessionId;
const WORKER = '00000000-0000-0000-0000-0000000000e4' as SessionId;
const RUN_ID = '00000000-0000-0000-0000-0000000000e5';
const INPUT = `inline:${Buffer.from('{}').toString('base64')}` as PayloadRef;

const deps = { redis: {} as never, db: {} as never, payloadStore: {} as never };

function anchor(state: Partial<SessionHotState> | null): void {
  mockGetSessionState.mockResolvedValue(
    state === null ? null : { sessionId: ANCHOR, status: 'RUNNING', spaceId: SPACE, ...state },
  );
}

async function runnerActivation(): Promise<boolean | undefined> {
  await spawnRunnerSession(deps, {
    tenantId: TENANT,
    spaceId: SPACE,
    workerSessionId: WORKER,
    helmsmanSessionId: ANCHOR,
    workflowExecution: { runId: RUN_ID, taskId: 'research', attempt: 1 },
    inputRef: INPUT,
    agentDefinitionRef: 'cybernetic-runner',
    traceId: 'trace-w' as TraceId,
  } as never);
  const queued = mockSetSessionState.mock.calls[0]?.[1] as SessionHotState;
  expect(queued.sessionId).toBe(WORKER);
  expect(mockAddControlMessage.mock.calls[0]?.[1]).not.toHaveProperty('trigger');
  return queued.activatedByPerson;
}

async function operationJobActivation(operationId: string): Promise<boolean | undefined> {
  const authority = await resolveWorkflowTaskAuthority(
    deps.redis,
    deps.db,
    TENANT,
    ANCHOR,
    await mockGetSessionState(),
    WORKER,
  );
  await dispatchClaimedOperationTask(deps, {
    tenantId: TENANT,
    runId: RUN_ID,
    taskId: 'read-inbox',
    attempt: 1,
    dispatchAttemptToken: `dispatch:${RUN_ID}:read-inbox:1`,
    operationId,
    workerSessionId: WORKER,
    inputRef: INPUT,
    traceId: 'trace-w' as TraceId,
    spaceId: SPACE,
    snoozeDelayMs: 0,
    activatedByPerson: authority.activatedByPerson,
  });
  const job = mockAddStepJob.mock.calls[0]?.[1] as Record<string, unknown>;
  expect(job['operationId']).toBe(operationId);
  return job['activatedByPerson'] as boolean | undefined;
}

beforeEach(() => {
  mockGetSessionState.mockReset();
  mockSetSessionState.mockReset().mockResolvedValue(undefined);
  mockAddControlMessage.mockReset().mockResolvedValue(undefined);
  mockAddStepJob.mockReset().mockResolvedValue('1-0');
  mockScheduleShardTimer.mockReset().mockResolvedValue(undefined);
});

describe('a workflow run started from a conversation a person is in', () => {
  it('queues its Runner attended', async () => {
    anchor({ trigger: 'chat', activatedByPerson: true });
    expect(await runnerActivation()).toBe(true);
  });

  it('stamps its operation tasks’ jobs attended', async () => {
    anchor({ trigger: 'voice', activatedByPerson: true });
    expect(await operationJobActivation('browser.page.open')).toBe(true);
  });
});

describe('the same conversation last woken by a schedule', () => {
  it('queues its Runner unattended, though a person started the conversation', async () => {
    anchor({ trigger: 'chat', activatedByPerson: false });
    expect(await runnerActivation()).toBe(false);
  });

  it('stamps its operation tasks’ jobs unattended', async () => {
    anchor({ trigger: 'chat', activatedByPerson: false });
    expect(await operationJobActivation('browser.page.open')).toBe(false);
  });
});

describe('an anchor whose state is gone', () => {
  it('gives its tasks no person', async () => {
    anchor(null);
    expect(await runnerActivation()).toBe(false);
    expect(await operationJobActivation('browser.page.open')).toBe(false);
  });
});

describe('a workflow task’s timer', () => {
  const timer = {
    tenantId: TENANT,
    stepExecutionId: WORKER,
    stepId: 'read-inbox',
    operationId: 'browser.page.read',
    stepType: 'browser',
    reason: 'delayed_start',
    attempt: 1,
    inputRef: INPUT,
    traceId: 'trace-w',
    dueAtMs: 1,
    spaceId: SPACE,
  } as unknown as TimerItem;
  const execution = {
    runId: RUN_ID,
    taskId: 'read-inbox',
    attempt: 1,
    dispatchAttemptToken: 'poll-1',
  };

  it('dispatches its job with what the timer was armed with', () => {
    expect(
      buildWorkflowTimerStepJob({ ...timer, activatedByPerson: true }, execution, 2)
        .activatedByPerson,
    ).toBe(true);
    expect(buildWorkflowTimerStepJob(timer, execution, 2)).not.toHaveProperty('activatedByPerson');
  });

  it('is armed with it by a snoozed task', async () => {
    await dispatchClaimedOperationTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: 'wait',
      attempt: 1,
      dispatchAttemptToken: 'snooze-1',
      operationId: SNOOZE_OPERATION_ID,
      workerSessionId: WORKER,
      inputRef: INPUT,
      traceId: 'trace-w' as TraceId,
      spaceId: SPACE,
      snoozeDelayMs: 1_000,
      activatedByPerson: true,
    });
    expect(mockScheduleShardTimer.mock.calls[0]?.[1]).toMatchObject({ activatedByPerson: true });
  });
});
