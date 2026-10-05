/**
 * Whether a session's jobs are attended is a fact of what last set it going,
 * not of how it was born. A conversation a person starts is attended; a
 * schedule that resumes it hours later finds nobody there, and every job it
 * schedules says so; the person's next message, or an operator's answer in
 * the Action Center, makes it attended again. A child run returning to the
 * parent that waited on it is not a new activation but the rest of the one
 * that delegated, so the parent stays as attended as it was; a paused child
 * its parent answers is attended as the parent is then. A resume that knows
 * nothing of who is present — finishing an OAuth consent — leaves the
 * session as it was. Hot state lives
 * in a Redis the whole chain reads and writes, so each step sees what the one
 * before it stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import {
  getSessionState,
  serializeRunAccessGrant,
  setSessionState,
  setStepState,
  updateSessionState,
  updateStepState,
} from '@aflow/redis';
import {
  type AgentDefinition,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  ControlMessageSchema,
  getOperation,
  type IdempotencyKey,
  type PayloadRef,
  type RunAccessGrant,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type SystemRole,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const jobs = vi.hoisted(() => ({ added: [] as Array<Record<string, unknown>> }));
const control = vi.hoisted(() => ({ sent: [] as unknown[] }));

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addStepJob: (_redis: unknown, job: Record<string, unknown>) => {
    jobs.added.push(job);
    return Promise.resolve('1-0');
  },
  addControlMessage: (_redis: unknown, message: unknown) => {
    control.sent.push(message);
    return Promise.resolve('1-0');
  },
  // The child list and the delegation lifecycle are kept by scripts this Redis
  // cannot run; one child, now done.
  removeWaitingChild: () => Promise.resolve(0),
  addWaitingChild: () => Promise.resolve(undefined),
  abortDelegationLifecycle: () => Promise.resolve(undefined),
}));

vi.mock('../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: () => Promise.resolve(structuredClone(agentDefinition)),
}));

vi.mock('../helpers/stepInputResolution.js', () => ({
  resolveStepInput: (_store: unknown, _step: unknown, inputRef: string) =>
    Promise.resolve(inputRef),
  StepInputValidationError: class StepInputValidationError extends Error {},
}));

vi.mock('../scheduling/relayWorkflowTaskActivity.js', () => ({
  createRelayWorkflowTaskActivity: () => () => Promise.resolve(undefined),
}));

const { createStartRun } = await import('../lifecycle/startRun.js');
const { createResumeRun } = await import('../lifecycle/resumeRun.js');
const { createScheduleStep } = await import('../scheduling/scheduleStep.js');
const { resumeParentOnChildComplete } = await import('../handlers/resumeParentOnChildComplete.js');
const { handleResumeInline } = await import('../handlers/inlineOps/resume.js');
const { ScheduleEvaluator } = await import('../../ScheduleEvaluator.js');

const TENANT = 'a0000000-0000-4000-8000-0000000000f1' as TenantId;
const SPACE = '00000000-0000-4000-8000-0000000000f2';
const RUN = '00000000-0000-4000-8000-0000000000f3' as SessionId;
const OPEN = 'open';
const EMPTY = 'inline:e30=' as PayloadRef;

const agentDefinition = {
  flowId: 'browsing-agent',
  version: '1',
  startStepId: OPEN,
  stateVariables: [],
  steps: [
    {
      stepId: OPEN,
      stepType: 'browser',
      operation: BROWSER_PAGE_OPEN_OPERATION_ID,
      name: 'open',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    },
  ],
} as unknown as AgentDefinition;

const opened = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID);

function grant(): RunAccessGrant {
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-4000-8000-0000000000f4',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        { capabilityGroupId: opened?.capabilityGroupId ?? 'browser.page', accessMode: 'write' },
      ],
      deniedCapabilities: [],
      allowedRiskModifiers: [...(opened?.riskModifiers ?? [])],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

const payloadStore = {
  retrieve: (ref: string) =>
    Promise.resolve(JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString())),
  store: (_ctx: unknown, data: unknown) =>
    Promise.resolve(`inline:${Buffer.from(JSON.stringify(data)).toString('base64')}`),
} as unknown as PayloadStore;

let redis: RedisType;
let lifecycle: ReturnType<typeof build>;

function build(store: RedisType) {
  const bindings = {
    deps: { db: {}, redis: store, payloadStore, consumerName: 'test' },
    relayActivity: { throttle: new Map() },
    applyResult: () => Promise.resolve(undefined),
  } as unknown as Parameters<typeof createStartRun>[0];
  bindings.scheduleStep = createScheduleStep(bindings);
  return {
    startRun: createStartRun(bindings),
    resumeRun: createResumeRun(bindings),
    scheduleStep: bindings.scheduleStep,
  };
}

/** The session parked on its current step, as an executor's pause leaves it. */
async function pauseOnCurrentStep(): Promise<StepExecutionId> {
  const state = await getSessionState(redis, TENANT, RUN);
  const stepExecutionId = state?.currentStepExecutionId as StepExecutionId;
  await updateStepState(redis, TENANT, stepExecutionId, { sessionId: RUN, status: 'PAUSED' });
  await updateSessionState(redis, TENANT, RUN, { status: 'PAUSED' });
  return stepExecutionId;
}

/** A resume command, read as the control consumer reads one and handed on as it does. */
async function deliverResume(message: unknown): Promise<void> {
  const parsed = ControlMessageSchema.parse(message);
  if (parsed.type !== 'resume_run') throw new Error(`expected a resume, got ${parsed.type}`);
  await lifecycle.resumeRun({
    tenantId: parsed.tenantId,
    runId: parsed.runId,
    stepExecutionId: parsed.stepExecutionId,
    inputRef: parsed.inputRef,
    traceId: parsed.traceId,
    idempotencyKey: parsed.idempotencyKey,
    ...(parsed.activatedByPerson !== undefined
      ? { activatedByPerson: parsed.activatedByPerson }
      : {}),
  });
}

function resumeCommand(stepExecutionId: StepExecutionId, activatedByPerson: boolean) {
  return {
    messageVersion: 1,
    type: 'resume_run',
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId,
    inputRef: EMPTY,
    traceId: 'trace-resume',
    idempotencyKey: `resume-${stepExecutionId}`,
    requestedAtMs: Date.now(),
    activatedByPerson,
  };
}

/** A schedule's resume of the session, fired by the evaluator as it fires one. */
async function scheduleFiresResume(): Promise<unknown> {
  const evaluator = new ScheduleEvaluator({
    redis,
    sqlClient: { unsafe: () => Promise.resolve([]) } as unknown as postgres.Sql,
    mode: 'observe',
  });
  const dispatchOne = (
    evaluator as unknown as { dispatchOne(row: unknown): Promise<{ kind: string }> }
  ).dispatchOne.bind(evaluator);
  const outcome = await dispatchOne({
    dispatch: {
      tenantId: TENANT,
      scheduleId: '00000000-0000-4000-8000-0000000000f5',
      scheduleName: 'morning check',
      schemaName: 'tenant_test',
      spaceId: SPACE,
      action: 'resume_run',
      targetKind: null,
      targetSystemRole: null,
      targetAgentId: null,
      agentVersion: null,
      targetSessionId: RUN,
      targetStepExecutionId: null,
      resolvedInput: {},
      firingCount: 1,
      idempotencyKey: `schedule-${String(Date.now())}-${String(Math.random())}`,
      creatorUserId: '00000000-0000-4000-8000-0000000000f4',
      creatorTenantRole: 'member',
      creatorSpaceRole: 'editor',
    },
  });
  expect(outcome.kind).toBe('completed');
  return control.sent.at(-1);
}

function lastJob(): Record<string, unknown> {
  const job = jobs.added.at(-1);
  if (job === undefined) throw new Error('no job was scheduled');
  return job;
}

beforeEach(async () => {
  jobs.added.length = 0;
  control.sent.length = 0;
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  lifecycle = build(redis);
  await setSessionState(redis, {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'browsing-agent' as SystemRole },
    agentVersion: '1',
    status: 'QUEUED',
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    spaceId: SPACE,
    grantJson: serializeRunAccessGrant(grant()),
  });
});

async function chatStart(): Promise<void> {
  await lifecycle.startRun({
    tenantId: TENANT,
    runId: RUN,
    target: { kind: 'platform-role', systemRole: 'browsing-agent' as SystemRole },
    agentVersion: '1',
    inputRef: EMPTY,
    traceId: 'trace-start' as TraceId,
    idempotencyKey: 'start-1' as IdempotencyKey,
    spaceId: SPACE,
    trigger: 'chat',
    activatedByPerson: true,
  });
}

describe('a conversation a person starts, then a schedule resumes', () => {
  it('is attended from its start', async () => {
    await chatStart();
    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(true);
    expect(lastJob()['activatedByPerson']).toBe(true);
  });

  it('schedules every job after a schedule-fired resume as unattended', async () => {
    await chatStart();
    const paused = await pauseOnCurrentStep();

    const fired = await scheduleFiresResume();
    expect(fired).toMatchObject({ type: 'resume_run', stepExecutionId: paused });
    await deliverResume(fired);

    const state = await getSessionState(redis, TENANT, RUN);
    expect(state?.trigger).toBe('chat');
    expect(state?.activatedByPerson).toBe(false);
    expect(lastJob()).toMatchObject({ operationId: BROWSER_PAGE_OPEN_OPERATION_ID });
    expect(lastJob()['activatedByPerson']).toBe(false);
  });

  it.each([
    ['the person’s next message'],
    ['an operator’s answer to the paused step in the Action Center'],
  ])('is attended again from %s', async () => {
    await chatStart();
    await pauseOnCurrentStep();
    await deliverResume(await scheduleFiresResume());
    expect(lastJob()['activatedByPerson']).toBe(false);

    // Both reach the orchestrator as a resume the API marked a person's,
    // because the request carrying them was authenticated as one.
    const paused = await pauseOnCurrentStep();
    await deliverResume(resumeCommand(paused, true));

    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(true);
    expect(lastJob()['activatedByPerson']).toBe(true);
  });
});

describe('a session resumed by finishing the OAuth consent it paused on', () => {
  /** The resume the consent callback sends: it states nothing about who is present. */
  async function consentCompletes(): Promise<void> {
    const paused = await pauseOnCurrentStep();
    const { activatedByPerson: _unstated, ...consentResume } = resumeCommand(paused, true);
    await deliverResume(consentResume);
  }

  it('stays attended when a person was attending it', async () => {
    await chatStart();
    await consentCompletes();

    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(true);
    expect(lastJob()['activatedByPerson']).toBe(true);
  });

  it('stays unattended when nobody was', async () => {
    await chatStart();
    await pauseOnCurrentStep();
    await deliverResume(await scheduleFiresResume());
    expect(lastJob()['activatedByPerson']).toBe(false);

    await consentCompletes();

    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(false);
    expect(lastJob()['activatedByPerson']).toBe(false);
  });

  it('is still made unattended by a schedule-fired resume afterwards', async () => {
    await chatStart();
    await consentCompletes();
    await pauseOnCurrentStep();

    const fired = await scheduleFiresResume();
    expect(fired).toMatchObject({ activatedByPerson: false });
    await deliverResume(fired);

    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(false);
    expect(lastJob()['activatedByPerson']).toBe(false);
  });
});

describe('a parent woken by the child it delegated to and waited on', () => {
  const CHILD = '00000000-0000-4000-8000-0000000000f6' as SessionId;
  const DELEGATE_STEP = '00000000-0000-4000-8000-0000000000f7' as StepExecutionId;

  /** The parent delegates and waits, then its child succeeds and wakes it. */
  async function childReturnsTo(parentActivatedByPerson: boolean): Promise<void> {
    const now = Date.now();
    await setSessionState(redis, {
      sessionId: RUN,
      tenantId: TENANT,
      target: { kind: 'platform-role', systemRole: 'browsing-agent' as SystemRole },
      agentVersion: '1',
      status: 'WAITING_ON_CHILD',
      createdAt: now,
      lastUpdatedAt: now,
      spaceId: SPACE,
      grantJson: serializeRunAccessGrant(grant()),
      trigger: 'chat',
      activatedByPerson: parentActivatedByPerson,
      traceId: 'trace-parent',
      currentStepExecutionId: DELEGATE_STEP,
      delegationPauseSource: 'child_running',
      waitingForChildSessionIds: [CHILD],
    });
    await setSessionState(redis, {
      sessionId: CHILD,
      tenantId: TENANT,
      target: { kind: 'platform-role', systemRole: 'web-researcher' as SystemRole },
      agentVersion: '1',
      status: 'SUCCEEDED',
      createdAt: now,
      lastUpdatedAt: now,
      spaceId: SPACE,
      activatedByPerson: parentActivatedByPerson,
      parentSessionId: RUN,
      parentStepExecutionId: DELEGATE_STEP,
    });
    await setStepState(redis, {
      stepExecutionId: DELEGATE_STEP,
      tenantId: TENANT,
      sessionId: RUN,
      stepId: 'delegate',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
      status: 'PAUSED',
      scheduledAt: now,
      inputRef: EMPTY,
      idempotencyKey: 'delegate-1',
      traceId: 'trace-parent',
    });

    await resumeParentOnChildComplete(redis, TENANT, CHILD, 'SUCCEEDED', EMPTY);
    expect((await getSessionState(redis, TENANT, RUN))?.status).toBe('RUNNING');
  }

  /** The parent's next browser call, as its agent would take it with the child's answer. */
  async function parentSchedulesNext(): Promise<Record<string, unknown>> {
    await lifecycle.scheduleStep({
      context: {
        tenantId: TENANT,
        runId: RUN,
        agentDefinition,
        traceId: 'trace-parent' as TraceId,
      },
      stepId: OPEN as StepId,
      inputRef: EMPTY,
    });
    expect(lastJob()).toMatchObject({
      sessionId: RUN,
      operationId: BROWSER_PAGE_OPEN_OPERATION_ID,
    });
    return lastJob();
  }

  it('stays attended when a person was there as it delegated, so its next jobs are too', async () => {
    await childReturnsTo(true);
    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(true);
    expect((await parentSchedulesNext())['activatedByPerson']).toBe(true);
  });

  it('stays unattended when nobody was', async () => {
    await childReturnsTo(false);
    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(false);
    expect((await parentSchedulesNext())['activatedByPerson']).toBe(false);
  });

  it('is unattended once a schedule resumes it afterwards', async () => {
    await childReturnsTo(true);
    await parentSchedulesNext();
    await pauseOnCurrentStep();
    await deliverResume(await scheduleFiresResume());

    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(false);
    expect(lastJob()['activatedByPerson']).toBe(false);
  });
});

describe('a sub-agent its parent answers while it is paused', () => {
  const PARENT = '00000000-0000-4000-8000-0000000000f8' as SessionId;

  async function parentNamed(activatedByPerson: boolean): Promise<void> {
    await setSessionState(redis, {
      sessionId: PARENT,
      tenantId: TENANT,
      target: { kind: 'platform-role', systemRole: 'helmsman' as SystemRole },
      agentVersion: '1',
      status: 'RUNNING',
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      spaceId: SPACE,
      trigger: 'chat',
      activatedByPerson,
    });
  }

  /**
   * The parent delegates while it is `atDelegation`, the child pauses on its
   * question, and the parent answers it with `agent.control.resume` while it is
   * `atAnswer`. Returns the browser job the child schedules next.
   */
  async function answeredChildSchedules(
    atDelegation: boolean,
    atAnswer: boolean,
  ): Promise<Record<string, unknown>> {
    await parentNamed(atDelegation);
    await lifecycle.startRun({
      tenantId: TENANT,
      runId: RUN,
      target: { kind: 'platform-role', systemRole: 'browsing-agent' as SystemRole },
      agentVersion: '1',
      inputRef: EMPTY,
      traceId: 'trace-child' as TraceId,
      idempotencyKey: 'start-child' as IdempotencyKey,
      spaceId: SPACE,
      activatedByPerson: atDelegation,
    });
    await pauseOnCurrentStep();
    await updateSessionState(redis, TENANT, PARENT, { activatedByPerson: atAnswer });

    await handleResumeInline({
      redis,
      payloadStore,
      context: { tenantId: TENANT, runId: PARENT, traceId: 'trace-parent', agentDefinition },
      stepDef: {
        stepId: 'resume',
        stepType: 'agent',
        operation: 'agent.control.resume',
        config: {},
        tags: [],
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
      stepExecutionId: '00000000-0000-4000-8000-0000000000f9' as StepExecutionId,
      idempotencyKey: 'resume-child' as IdempotencyKey,
      resolvedInputRef: `inline:${Buffer.from(JSON.stringify({ childSessionId: RUN, message: 'go on' })).toString('base64')}`,
      attempt: 1,
      scheduledAtMs: Date.now(),
    } as unknown as Parameters<typeof handleResumeInline>[0]);

    const scheduledBefore = jobs.added.length;
    await deliverResume(control.sent.at(-1));
    expect(jobs.added.length).toBeGreaterThan(scheduledBefore);
    expect(lastJob()).toMatchObject({
      sessionId: RUN,
      operationId: BROWSER_PAGE_OPEN_OPERATION_ID,
    });
    return lastJob();
  }

  it('is attended when a person is present for the parent as it answers, though nobody was when it delegated', async () => {
    const job = await answeredChildSchedules(false, true);
    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(true);
    // What a closed profile admits: the executor reads this stamp and nothing else.
    expect(job['activatedByPerson']).toBe(true);
  });

  it('is unattended when nobody is present for the parent as it answers, though a person was when it delegated', async () => {
    const job = await answeredChildSchedules(true, false);
    expect((await getSessionState(redis, TENANT, RUN))?.activatedByPerson).toBe(false);
    expect(job['activatedByPerson']).toBe(false);
  });
});
