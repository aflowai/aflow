/**
 * A resume of a step parked on an approval is decided by the grant the
 * authenticated resolve wrote, and by nothing the resume carries: a scheduled
 * `{}` wake or an agent-driven resume with no grant on record leaves the step
 * paused, for both variants of the approval payload.
 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import { writeApprovalGrantKey } from '@aflow/redis';
import { toAgentToolError, type WriteApprovalGrant } from '@aflow/schemas';

import { decideWriteApprovalResume, resolveWriteApprovalBlockedOn } from '../writeApprovalPause.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = 'run-1';

const BROWSER_REQUEST = {
  kind: 'write_approval',
  target: 'browser',
  profileId: 'default',
  pageOrigin: 'https://shop.example.com',
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
