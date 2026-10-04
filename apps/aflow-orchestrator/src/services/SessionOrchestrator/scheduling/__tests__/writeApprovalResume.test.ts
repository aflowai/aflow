/**
 * A resume of a step parked on an approval is decided by the grant the
 * authenticated resolve wrote, and by nothing the resume carries: a scheduled
 * `{}` wake or an agent-driven resume with no grant on record leaves the step
 * paused, for both variants of the approval payload. A browser request asked
 * again after its approval was spent is answered only by a decision made
 * after it was asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import { writeApprovalGrantKey } from '@aflow/redis';
import { toAgentToolError, type WriteApprovalGrant } from '@aflow/schemas';

const hot = vi.hoisted(() => ({
  session: undefined as unknown,
  atomicCompleteStep: vi.fn(),
  addStepResult: vi.fn(),
  updateStepState: vi.fn(),
}));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    isSessionCorrupt: () => Promise.resolve(false),
    getSessionStateSafe: () => Promise.resolve({ ok: true, state: hot.session }),
    getStepState: () =>
      Promise.resolve({
        stepId: 'act',
        stepType: 'browser',
        attempt: 1,
        status: 'PAUSED',
        inputRef: 'inline:e30=',
      }),
    atomicCompleteStep: hot.atomicCompleteStep,
    addStepResult: hot.addStepResult,
    updateStepState: hot.updateStepState,
  };
});

vi.mock('../../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: () =>
    Promise.resolve({
      steps: [{ stepId: 'act', stepType: 'browser', operation: 'browser.page.act' }],
    }),
}));

vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildRunStatusChangedRecoveryEvent: () => Promise.resolve([]),
}));

import { createResumeRun } from '../../lifecycle/resumeRun.js';
import { decideWriteApprovalResume, resolveWriteApprovalBlockedOn } from '../writeApprovalPause.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = 'run-1';

const BROWSER_REQUEST = {
  kind: 'write_approval',
  target: 'browser',
  profileId: 'default',
  pageOrigin: 'https://shop.example.com',
  pagePath: '/checkout',
  pageTitle: 'Checkout',
  action: 'click',
  element: { ref: 'e6', role: 'button', name: 'Pay now' },
  askedBy: { kind: 'posture' },
  standsUntil: '2026-10-04T13:00:00.000Z',
  requestHash: 'browser-hash-1',
};

const API_REQUEST = {
  kind: 'write_approval',
  target: 'api',
  apiId: 'etoro-trading',
  endpointId: 'createOrder',
  method: 'POST',
  urlHost: 'public-api.etoro.com',
  writeRiskTier: 'high',
  requestHash: 'api-hash-1',
};

function ref(payload: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

const payloadStore = {
  retrieve: (stored: string) =>
    Promise.resolve(JSON.parse(Buffer.from(stored.slice(7), 'base64').toString('utf8'))),
} as unknown as PayloadStore;

/** Only what the resolve boundary wrote, read back as Redis would. */
function grants(entries: ReadonlyArray<WriteApprovalGrant> = []): Redis {
  const stored = new Map(
    entries.map((grant) => [
      writeApprovalGrantKey(TENANT, RUN, grant.requestHash),
      JSON.stringify(grant),
    ]),
  );
  return { get: (key: string) => Promise.resolve(stored.get(key) ?? null) } as unknown as Redis;
}

function decide(payload: unknown, redis: Redis) {
  return decideWriteApprovalResume(
    { payloadStore, redis },
    { tenantId: TENANT, runId: RUN, requestedInputRef: ref(payload) },
  );
}

describe('a resume of an approval pause', () => {
  it('stays paused when no operator decided — a scheduled or agent-driven resume approves nothing', async () => {
    for (const payload of [BROWSER_REQUEST, API_REQUEST]) {
      expect(await decide(payload, grants())).toEqual({ decision: 'undecided' });
    }
  });

  it('re-dispatches only on the grant for this request', async () => {
    const approved = grants([{ requestHash: 'browser-hash-1', decision: 'approved' }]);
    expect(await decide(BROWSER_REQUEST, approved)).toEqual({ decision: 'approved' });
    expect(await decide({ ...BROWSER_REQUEST, requestHash: 'other' }, approved)).toEqual({
      decision: 'undecided',
    });
  });

  it('fails a denied browser action with a non-retryable permission error carrying the reason', async () => {
    const resumed = await decide(
      BROWSER_REQUEST,
      grants([{ requestHash: 'browser-hash-1', decision: 'denied', reason: 'Not this card.' }]),
    );
    if (resumed?.decision !== 'denied') throw new Error('expected a denial');
    expect(resumed.error).toMatchObject({ classification: 'permission', retryable: false });
    expect(resumed.error.message).toContain('Not this card.');
    expect(resumed.error.message).toContain('click on https://shop.example.com');
    expect(toAgentToolError(resumed.error).retry).toBe(false);
  });

  it('is not an approval pause for any other paused step', async () => {
    expect(await decide({ kind: 'approval', title: 'Approve?' }, grants())).toBeNull();
  });
});

const SPENT_AT = '2026-10-04T12:00:01.000Z';
const NEWER = '2026-10-04T12:05:00.000Z';
const OLDER = '2026-10-04T11:59:00.000Z';

/** The request asked again after its approval at `SPENT_AT` let one action through. */
const ASKED_AGAIN = { ...BROWSER_REQUEST, decidedBefore: SPENT_AT };

describe('a browser request asked again after its approval was spent', () => {
  it('reads the spent approval as undecided', async () => {
    const spent = grants([
      { requestHash: 'browser-hash-1', decision: 'approved', decidedAt: SPENT_AT },
    ]);
    expect(await decide(ASKED_AGAIN, spent)).toEqual({ decision: 'undecided' });
  });

  it('reads an approval made after it was asked as the answer', async () => {
    const approved = grants([
      { requestHash: 'browser-hash-1', decision: 'approved', decidedAt: NEWER },
    ]);
    expect(await decide(ASKED_AGAIN, approved)).toEqual({ decision: 'approved' });
  });

  it('reads a denial made before it was asked as undecided, and one made after as the denial', async () => {
    const earlier = grants([
      { requestHash: 'browser-hash-1', decision: 'denied', decidedAt: OLDER },
    ]);
    expect(await decide(ASKED_AGAIN, earlier)).toEqual({ decision: 'undecided' });
    const later = grants([{ requestHash: 'browser-hash-1', decision: 'denied', decidedAt: NEWER }]);
    expect((await decide(ASKED_AGAIN, later))?.decision).toBe('denied');
  });
});

describe('the API variant', () => {
  it('is decided by any grant on record for its request, whenever it was made', async () => {
    for (const decidedAt of [OLDER, SPENT_AT, NEWER]) {
      expect(
        await decide(
          API_REQUEST,
          grants([{ requestHash: 'api-hash-1', decision: 'approved', decidedAt }]),
        ),
      ).toEqual({ decision: 'approved' });
      expect(
        (
          await decide(
            API_REQUEST,
            grants([{ requestHash: 'api-hash-1', decision: 'denied', decidedAt }]),
          )
        )?.decision,
      ).toBe('denied');
    }
    expect(
      await decide(API_REQUEST, grants([{ requestHash: 'api-hash-1', decision: 'approved' }])),
    ).toEqual({ decision: 'approved' });
  });
});

describe('a resume of a run paused on a browser request asked again', () => {
  const STEP = '00000000-0000-4000-8000-0000000000a1';
  const scheduleStep = vi.fn();

  function resumeWith(onRecord: WriteApprovalGrant) {
    hot.session = {
      status: 'PAUSED',
      currentStepExecutionId: STEP,
      pauseType: 'user_input',
      requestedInputRef: ref(ASKED_AGAIN),
      target: { kind: 'inline-agent', definitionRef: 'inline:e30=' },
      agentVersion: '1',
    };
    const resumeRun = createResumeRun({
      deps: { db: {}, redis: grants([onRecord]), payloadStore },
      scheduleStep,
    } as never);
    // A scheduled wake: it carries nothing, and no operator sent it.
    return resumeRun({
      tenantId: TENANT as never,
      runId: RUN as never,
      stepExecutionId: STEP as never,
      inputRef: ref({}),
      traceId: 'trace-1' as never,
      idempotencyKey: 'wake-1' as never,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays paused on a scheduled wake while only the spent approval is on record, and dispatches nothing', async () => {
    const resumed = await resumeWith({
      requestHash: 'browser-hash-1',
      decision: 'approved',
      decidedAt: SPENT_AT,
    });
    expect(resumed).toEqual({ status: 'PAUSED' });
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(hot.atomicCompleteStep).not.toHaveBeenCalled();
    expect(hot.addStepResult).not.toHaveBeenCalled();
  });

  it('dispatches the step once on the operator’s new approval', async () => {
    const resumed = await resumeWith({
      requestHash: 'browser-hash-1',
      decision: 'approved',
      decidedAt: NEWER,
    });
    expect(resumed).toEqual({ status: 'RUNNING' });
    expect(scheduleStep).toHaveBeenCalledOnce();
    expect(scheduleStep.mock.calls[0]?.[0]).toMatchObject({ stepId: 'act' });
    expect(hot.addStepResult).not.toHaveBeenCalled();
  });

  it('does not ask again on a scheduled wake while an earlier denial is on record', async () => {
    const resumed = await resumeWith({
      requestHash: 'browser-hash-1',
      decision: 'denied',
      decidedAt: OLDER,
    });
    expect(resumed).toEqual({ status: 'PAUSED' });
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(hot.atomicCompleteStep).not.toHaveBeenCalled();
  });
});

describe('the blocked-on cause of an approval pause', () => {
  it('names the browser action for the browser variant', async () => {
    expect(
      await resolveWriteApprovalBlockedOn(payloadStore, ref(BROWSER_REQUEST), 'step-1'),
    ).toEqual({
      kind: 'needs_write_approval',
      target: 'browser',
      stepExecutionId: 'step-1',
      profileId: 'default',
      pageOrigin: 'https://shop.example.com',
      action: 'click',
      elementRole: 'button',
      elementName: 'Pay now',
      requestHash: 'browser-hash-1',
    });
  });

  it('names the call for the API variant', async () => {
    expect(
      await resolveWriteApprovalBlockedOn(payloadStore, ref(API_REQUEST), 'step-1'),
    ).toMatchObject({
      kind: 'needs_write_approval',
      target: 'api',
      method: 'POST',
      urlHost: 'public-api.etoro.com',
    });
  });
});
