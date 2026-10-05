/**
 * Whether anything consumes the control, result and timer streams, read from
 * the orchestrators' liveness leases. A dead orchestrator leaves its lease in
 * place, so the reading still says when the last one beat.
 */
import { describe, expect, it } from 'vitest';

import {
  INSTANCE_LEASE_TTL_MS,
  ORCHESTRATOR_ABSENT_NOTICE,
  orchestratorAbsentNotice,
  orchestratorHealthFrom,
} from '../streams/orchestratorHeartbeat.js';

const NOW_MS = Date.parse('2026-10-05T12:00:00.000Z');
const SECOND_MS = 1000;

describe('the orchestrator health reading', () => {
  it('is alive while a lease is live, and dates its freshest beat on Redis’ clock', () => {
    const beatMs = NOW_MS - 4 * SECOND_MS;
    expect(
      orchestratorHealthFrom({
        live: 1,
        freshestLeaseExpiresAtMs: beatMs + INSTANCE_LEASE_TTL_MS,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      alive: true,
      lastHeartbeat: new Date(beatMs).toISOString(),
      heartbeatAgeMs: 4 * SECOND_MS,
    });
  });

  it('is not alive once every lease has lapsed, and still says when the last one beat', () => {
    const fortyMinutesMs = 40 * 60 * SECOND_MS;
    const beatMs = NOW_MS - fortyMinutesMs;
    expect(
      orchestratorHealthFrom({
        live: 0,
        freshestLeaseExpiresAtMs: beatMs + INSTANCE_LEASE_TTL_MS,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      alive: false,
      lastHeartbeat: new Date(beatMs).toISOString(),
      heartbeatAgeMs: fortyMinutesMs,
    });
  });

  it('knows no beat where no orchestrator has ever registered', () => {
    expect(
      orchestratorHealthFrom({ live: 0, freshestLeaseExpiresAtMs: null, nowMs: NOW_MS }),
    ).toEqual({ alive: false, lastHeartbeat: null, heartbeatAgeMs: null });
  });
});

describe('the notice', () => {
  it('is said only while no orchestrator is alive', () => {
    expect(orchestratorAbsentNotice({ alive: true })).toBeNull();
    expect(orchestratorAbsentNotice({ alive: false })).toBe(ORCHESTRATOR_ABSENT_NOTICE);
  });

  it('names what waits, in the system’s voice', () => {
    expect(ORCHESTRATOR_ABSENT_NOTICE).toMatch(/messages, step results and cancellations wait/);
    expect(/\byou\b|\byour\b/i.test(ORCHESTRATOR_ABSENT_NOTICE)).toBe(false);
  });
});
