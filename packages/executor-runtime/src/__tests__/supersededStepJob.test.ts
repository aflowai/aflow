import { describe, it, expect } from 'vitest';
import { isSupersededStepJob } from '../executor/processJob.js';

/**
 * The stale-attempt fence drops a step job whose durable state has moved past it
 * — the core guard against re-executing a step after the stall watchdog failed
 * its attempt and retry scheduled a newer one (or it ended terminally FAILED).
 */
describe('isSupersededStepJob', () => {
  it('drops a job when a newer attempt has been scheduled', () => {
    expect(isSupersededStepJob({ attempt: 2, status: 'SCHEDULED' }, 1)).toBe(true);
    expect(isSupersededStepJob({ attempt: 2, status: 'STARTED' }, 1)).toBe(true);
  });

  it('drops a job when the step is already terminally FAILED at this attempt', () => {
    expect(isSupersededStepJob({ attempt: 1, status: 'FAILED' }, 1)).toBe(true);
  });

  it('runs the current attempt when state matches the job', () => {
    expect(isSupersededStepJob({ attempt: 1, status: 'SCHEDULED' }, 1)).toBe(false);
    expect(isSupersededStepJob({ attempt: 1, status: 'STARTED' }, 1)).toBe(false);
  });

  it('does not drop a SUCCEEDED/PAUSED step at this attempt (handled elsewhere)', () => {
    // SUCCEEDED is short-circuited by the output-exists re-emit path; PAUSED can
    // resume — neither should be force-dropped by the fence.
    expect(isSupersededStepJob({ attempt: 1, status: 'SUCCEEDED' }, 1)).toBe(false);
    expect(isSupersededStepJob({ attempt: 1, status: 'PAUSED' }, 1)).toBe(false);
  });

  it('fails open when state is missing/unreadable', () => {
    expect(isSupersededStepJob(null, 1)).toBe(false);
    expect(isSupersededStepJob(undefined, 1)).toBe(false);
  });
});
