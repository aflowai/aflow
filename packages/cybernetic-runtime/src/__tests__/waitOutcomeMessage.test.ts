/**
 * The chat folds a wait's room message to one line by reading back the words
 * `describeWaitOutcome` gives the agent. These cases fail where the words
 * change and the reader in `@aflow/schemas` does not follow them.
 */
import { describe, expect, it } from 'vitest';
import { readWaitOutcomeMessage, type WaitEvent, type WaitRegistration } from '@aflow/schemas';
import { describeWaitOutcome } from '../waits.js';

const T0 = 1_800_000_000_000;

function registration(
  kind: WaitRegistration['kind'],
  subject: string,
  owner?: WaitRegistration['owner'],
): WaitRegistration {
  return {
    waitId: '23e0cfeb-0000-4000-8000-000000000339',
    tenantId: 'a0000000-0000-4000-8000-000000000339',
    spaceId: '5e1d0000-0000-4000-8000-000000000339',
    kind,
    subject,
    sessionId: 'c0ffee00-0000-4000-8000-000000000339',
    declaredAt: T0,
    closesAt: T0 + 600_000,
    ...(owner !== undefined ? { owner } : {}),
  };
}

function event(kind: WaitEvent['kind'], subject: string, detail: WaitEvent['detail']): WaitEvent {
  return { kind, subject, firedAt: T0 + 1_000, detail };
}

describe('readWaitOutcomeMessage reads what describeWaitOutcome writes', () => {
  it('reads the first change of a pull request, past the later ones and the owner instruction', () => {
    const pull = 'aflowai/aflow#276';
    const words = describeWaitOutcome(
      registration('pull_request.changed', pull, {
        onEvent:
          'Run a Local PR Shepherd pass aimed at it: workflow.run.start with slug local-pr-shepherd.',
      }),
      {
        endedBy: 'event',
        event: event('pull_request.changed', pull, {
          change: 'checks_green',
          url: 'https://github.com/aflowai/aflow/pull/276',
          headSha: 'abc123',
        }),
        laterEvents: [event('pull_request.changed', pull, { change: 'merged' })],
      },
    );

    expect(readWaitOutcomeMessage(words)).toEqual({
      kind: 'pull_request.changed',
      subject: pull,
      endedBy: 'event',
      detail: { change: 'checks_green' },
    });
  });

  it('reads the status a run ended with', () => {
    const words = describeWaitOutcome(registration('run.ended', 'run-1'), {
      endedBy: 'event',
      event: event('run.ended', 'run-1', { status: 'failed' }),
    });

    expect(readWaitOutcomeMessage(words)).toMatchObject({
      kind: 'run.ended',
      detail: { status: 'failed' },
    });
  });

  it('reads the new status of a plan node, not the one it left', () => {
    const words = describeWaitOutcome(registration('plan.node.status_changed', 'node-1'), {
      endedBy: 'event',
      event: event('plan.node.status_changed', 'node-1', {
        status: 'done',
        previousStatus: 'blocked',
      }),
    });

    expect(readWaitOutcomeMessage(words)?.detail).toEqual({ status: 'done' });
  });

  it('reads the latest status of a plan node that moved again before delivery', () => {
    const words = describeWaitOutcome(registration('plan.node.status_changed', 'node-1'), {
      endedBy: 'event',
      event: event('plan.node.status_changed', 'node-1', {
        status: 'active',
        previousStatus: 'blocked',
      }),
      laterEvents: [
        event('plan.node.status_changed', 'node-1', { status: 'done', previousStatus: 'active' }),
      ],
    });

    expect(readWaitOutcomeMessage(words)?.detail).toEqual({ status: 'done' });
  });

  it('reads how a gate was resolved', () => {
    const words = describeWaitOutcome(registration('gate.resolved', 'item-1'), {
      endedBy: 'event',
      event: event('gate.resolved', 'item-1', { resolution: 'approved' }),
    });

    expect(readWaitOutcomeMessage(words)?.detail).toEqual({ resolution: 'approved' });
  });

  it('reads a window that closed with no event', () => {
    const words = describeWaitOutcome(registration('run.ended', 'run-1'), {
      endedBy: 'window_closed',
      closedAt: T0 + 600_000,
    });

    expect(readWaitOutcomeMessage(words)).toEqual({
      kind: 'run.ended',
      subject: 'run-1',
      endedBy: 'window_closed',
      detail: {},
    });
  });

  it('reads nothing from words of another author', () => {
    expect(readWaitOutcomeMessage('Can you look at the failing build?')).toBeNull();
  });
});
