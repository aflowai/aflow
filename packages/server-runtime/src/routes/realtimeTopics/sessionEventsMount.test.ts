/**
 * Which end of a session a fresh subscriber receives.
 *
 * The defect: a mount asked for a page from the START of the history and then
 * tailed live from its END, so a session longer than one page delivered its
 * oldest events, jumped to the newest, and silently omitted everything between.
 * This file exists because the topic that made that choice had no tests, and a
 * change to it once passed a full suite while being wrong.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SessionId, TenantId } from '@aflow/schemas';
import { readForSubscribe } from './sessionEvents.js';
import type { LatestResult, TailAfterResult } from '../../services/sessionTail.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SESSION = '00000000-0000-4000-8000-000000000001' as SessionId;

type PageOpts = { limit: number } | undefined;
type TailAfterFn = (
  tenantId: TenantId,
  sessionId: SessionId,
  cursor: string | undefined,
  opts?: PageOpts,
) => Promise<TailAfterResult>;
type TailBeforeFn = (
  tenantId: TenantId,
  sessionId: SessionId,
  beforeCursor: string | undefined,
  opts?: PageOpts,
) => Promise<LatestResult>;

/**
 * Typed rather than inferred: an inferred `vi.fn()` carries an empty parameter
 * tuple, so asserting on a recorded argument stops type-checking and quietly
 * stops being a check.
 */
function stubService() {
  return {
    tailAfter: vi.fn<TailAfterFn>(async () => ({
      kind: 'events' as const,
      events: [],
      eventCursors: [],
      nextCursor: '',
      hasMore: false,
    })),
    tailBefore: vi.fn<TailBeforeFn>(async () => ({
      events: [],
      eventCursors: [],
      nextCursor: '',
      hasOlder: false,
    })),
  };
}

describe('what a subscriber is given on subscribe', () => {
  it('opens a fresh session at its newest page', async () => {
    const svc = stubService();

    await readForSubscribe(svc, TENANT, SESSION, undefined);

    expect(svc.tailBefore).toHaveBeenCalledTimes(1);
    expect(svc.tailAfter).not.toHaveBeenCalled();
  });

  it('resumes a cursor forward, which is the correct end for a reconnect', async () => {
    const svc = stubService();

    await readForSubscribe(svc, TENANT, SESSION, 'some-cursor');

    expect(svc.tailAfter).toHaveBeenCalledTimes(1);
    expect(svc.tailAfter.mock.calls[0]?.[2]).toBe('some-cursor');
    expect(svc.tailBefore).not.toHaveBeenCalled();
  });

  it('treats an empty-string cursor as a cursor, not as a fresh mount', async () => {
    // The topic carries `string | undefined`; only `undefined` means "no
    // position". Collapsing the two would send a resuming client back to the
    // newest page and lose everything it had not yet seen.
    const svc = stubService();

    await readForSubscribe(svc, TENANT, SESSION, '');

    expect(svc.tailAfter).toHaveBeenCalledTimes(1);
    expect(svc.tailBefore).not.toHaveBeenCalled();
  });

  it('asks both reads for the same page size', async () => {
    const fresh = stubService();
    const resumed = stubService();

    await readForSubscribe(fresh, TENANT, SESSION, undefined, 250);
    await readForSubscribe(resumed, TENANT, SESSION, 'c', 250);

    expect(fresh.tailBefore.mock.calls[0]?.[3]).toEqual({ limit: 250 });
    expect(resumed.tailAfter.mock.calls[0]?.[3]).toEqual({ limit: 250 });
  });
});
