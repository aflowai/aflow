import { describe, expect, it } from 'vitest';

import {
  decodeSessionCursor,
  encodeSessionCursor,
  rememberSteps,
  statusKey,
  stepsNotSeen,
  type SessionCursor,
} from './sessionCursor.js';
import {
  STEP_HOT_STATE_EXPIRED,
  STEP_NOT_SCHEDULED,
  STEP_STATUS_NOT_READ,
  type StepSummary,
} from './sessionViews.js';

function step(step_id: string, status: string): StepSummary {
  return { step_id, status };
}

/** The cursor a call hands back after reading `steps`, as the next call decodes it. */
function after(cursor: SessionCursor | undefined, steps: StepSummary[]): SessionCursor {
  const decoded = decodeSessionCursor(encodeSessionCursor('RUNNING', rememberSteps(cursor, steps)));
  if (!decoded) throw new Error('cursor did not round-trip');
  return decoded;
}

describe('the session cursor', () => {
  it('holds a step that leaves the newest page as unchanged', () => {
    const seen = after(undefined, [step('a', 'SUCCEEDED'), step('b', 'RUNNING')]);

    const aged = [step('a', STEP_STATUS_NOT_READ), step('b', 'RUNNING')];
    expect(stepsNotSeen(seen, aged)).toEqual([]);
    expect(stepsNotSeen(seen, [step('a', STEP_HOT_STATE_EXPIRED)])).toEqual([]);
  });

  it('keeps the status last read across reads that could not see it', () => {
    const read = after(undefined, [step('a', 'SUCCEEDED')]);
    const unread = after(read, [step('a', STEP_STATUS_NOT_READ)]);
    const expired = after(unread, [step('a', STEP_HOT_STATE_EXPIRED)]);

    expect(expired.seen).toEqual(read.seen);
    expect(stepsNotSeen(expired, [step('a', 'SUCCEEDED')])).toEqual([]);
    expect(stepsNotSeen(expired, [step('a', 'FAILED')])).toEqual([step('a', 'FAILED')]);
  });

  it('keeps a step the read did not name', () => {
    const read = after(undefined, [step('a', 'SUCCEEDED'), step('b', 'RUNNING')]);
    const narrower = after(read, [step('b', 'SUCCEEDED')]);

    expect(stepsNotSeen(narrower, [step('a', 'SUCCEEDED')])).toEqual([]);
  });

  it('reports a step never seen whatever its status', () => {
    const seen = after(undefined, [step('a', 'SUCCEEDED')]);

    expect(stepsNotSeen(seen, [step('b', STEP_STATUS_NOT_READ)])).toEqual([
      step('b', STEP_STATUS_NOT_READ),
    ]);
  });

  it('reports a step first seen unreadable once its status is read', () => {
    const seen = after(undefined, [step('a', STEP_STATUS_NOT_READ)]);

    expect(stepsNotSeen(seen, [step('a', STEP_STATUS_NOT_READ)])).toEqual([]);
    expect(stepsNotSeen(seen, [step('a', 'SUCCEEDED')])).toEqual([step('a', 'SUCCEEDED')]);
  });

  it('tells every status a step can be read in apart', () => {
    const statuses = [
      'SCHEDULED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'PAUSED',
      'CANCELLED',
      STEP_NOT_SCHEDULED,
      STEP_STATUS_NOT_READ,
      STEP_HOT_STATE_EXPIRED,
    ];

    expect(new Set(statuses.map(statusKey)).size).toBe(statuses.length);
  });

  it('reads a malformed or older cursor as none', () => {
    expect(decodeSessionCursor('s3.RUNNING.abcdef')).toBeUndefined();
    expect(decodeSessionCursor('s4.RUNNING.abcdefg')).toBeUndefined();
  });
});
