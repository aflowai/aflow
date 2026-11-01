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
