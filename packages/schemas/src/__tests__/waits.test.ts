/**
 * The event kinds of the wait primitive (Plan 339 D1), and which entity
 * events carry them. The two entity events that came before the primitive
 * feed it; the kinds added for it carry their subject in their payload.
 */
import { describe, expect, it } from 'vitest';
import {
  WAIT_EVENT_KINDS,
  parsePullRequestRef,
  pullRequestSubject,
  readWaitOutcomeMessage,
  waitEventOfEntityEvent,
  type EntityEventEnvelope,
} from '../index.js';

const SPACE = '5e1d0000-0000-4000-8000-000000000339';

function entity(eventType: EntityEventEnvelope['eventType'], payload: Record<string, unknown>) {
  return {
    eventId: '9a7b3c2d-1e0f-4a5b-8c6d-7e8f9a0b1c2d',
    eventType,
    spaceId: SPACE,
    tenantId: 't',
    timestamp: 42,
    payload,
    summary: 's',
  } satisfies EntityEventEnvelope;
}

describe('the wait event kinds', () => {
  it('are the four of D1 with an emitter', () => {
    expect(WAIT_EVENT_KINDS).toEqual([
      'run.ended',
      'plan.node.status_changed',
      'pull_request.changed',
      'gate.resolved',
    ]);
  });
});

describe('waitEventOfEntityEvent', () => {
  it('reads a run that reached a terminal status as run.ended', () => {
    expect(
      waitEventOfEntityEvent(entity('entity.run.updated', { runId: 'r1', status: 'failed' })),
    ).toEqual({ kind: 'run.ended', subject: 'r1', firedAt: 42, detail: { status: 'failed' } });
    expect(
      waitEventOfEntityEvent(entity('entity.run.updated', { runId: 'r1', status: 'paused' })),
    ).toBeNull();
  });

  it('reads a plan write as a status change only where the status changed', () => {
    const write = (status: string, previousStatus?: string) =>
      entity('entity.plan.updated', {
        nodeId: 'n1',
        revision: 2,
        status,
        ...(previousStatus !== undefined ? { previousStatus } : {}),
      });
    expect(waitEventOfEntityEvent(write('done', 'active'))).toEqual({
      kind: 'plan.node.status_changed',
      subject: 'n1',
      firedAt: 42,
      detail: { status: 'done', previousStatus: 'active' },
    });
    expect(waitEventOfEntityEvent(write('active', 'active'))).toBeNull();
    expect(waitEventOfEntityEvent(write('active'))).toBeNull();
  });

  it('reads the kinds added for the primitive by the subject they carry', () => {
    expect(
      waitEventOfEntityEvent(
        entity('entity.pull_request.changed', { subject: 'o/r#1', change: 'merged' }),
      ),
    ).toEqual({
      kind: 'pull_request.changed',
      subject: 'o/r#1',
      firedAt: 42,
      detail: { change: 'merged' },
    });
    expect(
      waitEventOfEntityEvent(
        entity('entity.gate.resolved', { subject: 'item', resolution: 'approve' }),
      ),
    ).toMatchObject({ kind: 'gate.resolved', subject: 'item' });
    expect(waitEventOfEntityEvent(entity('entity.gate.resolved', {}))).toBeNull();
  });

  it('reads no wait event from any other entity event', () => {
    expect(waitEventOfEntityEvent(entity('entity.session.status', { sessionId: 'x' }))).toBeNull();
  });
});

describe('a pull request subject', () => {
  it('is owner/repo#number, read from a subject or a GitHub link alike', () => {
    expect(pullRequestSubject('AflowAI', 'Aflow', 276)).toBe('aflowai/aflow#276');
    expect(parsePullRequestRef('https://github.com/AflowAI/aflow/pull/276')).toEqual({
      owner: 'aflowai',
      repo: 'aflow',
      number: 276,
    });
    expect(parsePullRequestRef('aflowai/aflow#276')).toEqual({
      owner: 'aflowai',
      repo: 'aflow',
      number: 276,
    });
    expect(parsePullRequestRef('https://github.com/aflowai/aflow/issues/276')).toBeNull();
  });
});

/**
 * A wait's room message as `describeWaitOutcome` words it, its events given
 * oldest first. The last one is the body's status line.
 */
function waitOutcomeBody(kind: string, subject: string, events: readonly string[]): string {
  const [first, ...later] = events;
  return (
    `Your wait 23e0cfeb-0000-4000-8000-000000000339 on ${kind} on ${subject} has ended: ` +
    `the event arrived at ${first}. ` +
    (later.length > 0 ? `Later events on the subject before you were told: ${later.join('; ')}. ` : '') +
    'You own the subject, so the platform declared this wait for you. ' +
    // Words after the list that look like an event's never count as one.
    'Act on it at 2026-11-06T09:00:00.000Z (change: closed, status: completed, resolution: dismiss).'
  );
}

describe('readWaitOutcomeMessage folds to the status line the body ends its events with', () => {
  it('says a pull request merged where checks_green came first', () => {
    const statusLine = '2026-11-06T08:01:00.000Z (change: merged)';
    const body = waitOutcomeBody('pull_request.changed', 'aflowai/aflow#276', [
      '2026-11-06T08:00:00.000Z (change: checks_green, url: https://github.com/aflowai/aflow/pull/276, headSha: abc123)',
      statusLine,
    ]);

    const folded = readWaitOutcomeMessage(body)?.detail;
    expect(folded).toEqual({ change: 'merged' });
    expect(statusLine).toContain(`change: ${folded?.change}`);
  });

  it('says how a run ended where a later terminal event followed', () => {
    const statusLine = '2026-11-06T08:01:00.000Z (status: cancelled)';
    const body = waitOutcomeBody('run.ended', 'run-1', [
      '2026-11-06T08:00:00.000Z (status: failed)',
      statusLine,
    ]);

    const folded = readWaitOutcomeMessage(body)?.detail;
    expect(folded).toEqual({ status: 'cancelled' });
    expect(statusLine).toContain(`status: ${folded?.status}`);
  });

  it('says how a gate was resolved where a later resolution followed', () => {
    const statusLine = '2026-11-06T08:02:00.000Z (resolution: approve, actor: person-2)';
    const body = waitOutcomeBody('gate.resolved', 'item-1', [
      '2026-11-06T08:00:00.000Z (resolution: reassign, actor: person-1)',
      '2026-11-06T08:01:00.000Z (resolution: reject)',
      statusLine,
    ]);

    const folded = readWaitOutcomeMessage(body)?.detail;
    expect(folded).toEqual({ resolution: 'approve' });
    expect(statusLine).toContain(`resolution: ${folded?.resolution}`);
  });

  it('reads the one event where no later event followed', () => {
    const statusLine = '2026-11-06T08:00:00.000Z (change: checks_green, headSha: abc123)';
    const body = waitOutcomeBody('pull_request.changed', 'aflowai/aflow#276', [statusLine]);

    const folded = readWaitOutcomeMessage(body)?.detail;
    expect(folded).toEqual({ change: 'checks_green' });
    expect(statusLine).toContain(`change: ${folded?.change}`);
  });
});
