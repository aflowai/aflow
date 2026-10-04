import { describe, expect, it } from 'vitest';

import { scanStepStatuses, type StepEventLike, type StepEventPage } from './sessionDebugSteps.js';

let clock = Date.parse('2026-10-01T00:00:00Z');

function event(eventType: string, stepId: string, extra: Partial<StepEventLike> = {}) {
  clock += 1000;
  return {
    eventType,
    stepExecutionId: `exec-${stepId}`,
    timestamp: new Date(clock).toISOString(),
    data: { stepId },
    ...extra,
  } satisfies StepEventLike;
}

function lifecycle(stepId: string, last: 'StepSucceeded' | 'StepFailed' = 'StepSucceeded') {
  return [
    event('StepScheduled', stepId),
    event('StepStarted', stepId),
    event(last, stepId, last === 'StepFailed' ? { metadata: { errorMessage: 'refused' } } : {}),
  ];
}

/** Pages of `size` over `events`, newest first, the way the tail service hands them back. */
function paged(events: StepEventLike[], size: number) {
  const pageEnding = (end: number): StepEventPage<StepEventLike> => {
    const start = Math.max(0, end - size);
    return {
      events: events.slice(start, end),
      hasOlder: start > 0,
      ...(start > 0 ? { olderCursor: String(start) } : {}),
    };
  };
  let reads = 0;
  return {
    newest: pageEnding(events.length),
    readOlder: (cursor: string) => {
      reads++;
      return Promise.resolve(pageEnding(Number(cursor)));
    },
    reads: () => reads,
  };
}

describe('scanStepStatuses', () => {
  it('places a step whose events are older than the newest page', async () => {
    const history = [
      ...lifecycle('early'),
      ...Array.from({ length: 30 }, (_, i) => lifecycle(`s${String(i)}`)).flat(),
    ];
    const pages = paged(history, 20);
    const ids = new Set(['early', 's29']);

    const scan = await scanStepStatuses(ids, pages.newest, pages.readOlder);

    expect(scan.steps.get('early')).toEqual({
      status: 'SUCCEEDED',
      stepExecutionId: 'exec-early',
      durationMs: 2000,
    });
    expect(scan.steps.get('s29')?.status).toBe('SUCCEEDED');
    expect(scan.complete).toBe(true);
  });

  it('stops walking once every step is placed', async () => {
    const history = [...Array.from({ length: 30 }, (_, i) => lifecycle(`s${String(i)}`)).flat()];
    const pages = paged(history, 20);

    const scan = await scanStepStatuses(new Set(['s29']), pages.newest, pages.readOlder);

    expect(pages.reads()).toBe(0);
    expect(scan.complete).toBe(true);
  });

  it('takes the newest status and the failure message the step failed with', async () => {
    const history = [...lifecycle('tool', 'StepFailed')];
    const pages = paged(history, 50);

    const scan = await scanStepStatuses(new Set(['tool']), pages.newest, pages.readOlder);

    expect(scan.steps.get('tool')).toMatchObject({ status: 'FAILED', errorMessage: 'refused' });
  });

  it('reports a walk that reached the start without placing a step as complete', async () => {
    const pages = paged(lifecycle('other'), 50);

    const scan = await scanStepStatuses(new Set(['gone']), pages.newest, pages.readOlder);

    expect(scan.steps.has('gone')).toBe(false);
    expect(scan.complete).toBe(true);
  });

  it('stops at the bound and says the walk is incomplete', async () => {
    const history = [
      ...lifecycle('early'),
      ...Array.from({ length: 30 }, (_, i) => lifecycle(`s${String(i)}`)).flat(),
    ];
    const pages = paged(history, 20);

    const scan = await scanStepStatuses(new Set(['early']), pages.newest, pages.readOlder, 40);

    expect(scan.steps.has('early')).toBe(false);
    expect(scan.complete).toBe(false);
    expect(scan.eventsRead).toBe(40);
  });
});
