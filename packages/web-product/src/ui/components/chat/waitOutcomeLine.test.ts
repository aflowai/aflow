/**
 * The one line a person reads for a wait's room message says a wait ended,
 * what it was for and what ended it, and never the agent's instruction.
 */
import { describe, expect, it } from 'vitest';
import { WAIT_OUTCOME_ACTOR_ID } from '@aflow/schemas';
import { describeWaitOutcomeNotice, isWaitOutcomeMessage } from './waitOutcomeLine.js';

const PULL_REQUEST_BODY =
  'Your wait 23e0cfeb-0000-4000-8000-000000000339 on pull_request.changed on aflowai/aflow#315 has ended: ' +
  'the event arrived at 2026-11-06T08:00:00.000Z (change: checks_failed, url: https://github.com/aflowai/aflow/pull/315, headSha: abc123). ' +
  'You own the subject, so the platform declared this wait for you. ' +
  'Run a Local PR Shepherd pass aimed at it: workflow.run.start with slug local-pr-shepherd, bindingId: hb_aflow.';

describe('describeWaitOutcomeNotice', () => {
  it('names the pull request and its change, and leaves the instruction out', () => {
    const line = describeWaitOutcomeNotice(PULL_REQUEST_BODY);
    expect(line).toBe('Wait for pull request aflowai/aflow#315 ended: a check failed.');
    expect(line).not.toContain('workflow.run.start');
  });

  it('says a pull request merged where checks passed first, as its last status line says', () => {
    const statusLine = '2026-11-06T08:01:00.000Z (change: merged)';
    const line = describeWaitOutcomeNotice(
      'Your wait 23e0cfeb-0000-4000-8000-000000000339 on pull_request.changed on aflowai/aflow#315 has ended: ' +
        'the event arrived at 2026-11-06T08:00:00.000Z (change: checks_green, headSha: abc123). ' +
        `Later events on the subject before you were told: ${statusLine}. Act on it by your own rules.`,
    );
    expect(line).toBe('Wait for pull request aflowai/aflow#315 ended: it merged.');
    expect(statusLine).toContain('change: merged');
  });

  it('names the latest way a run ended, as its last status line says', () => {
    const statusLine = '2026-11-06T08:01:00.000Z (status: cancelled)';
    const line = describeWaitOutcomeNotice(
      'Your wait 23e0cfeb-0000-4000-8000-000000000339 on run.ended on run-1 has ended: ' +
        'the event arrived at 2026-11-06T08:00:00.000Z (status: failed). ' +
        `Later events on the subject before you were told: ${statusLine}. Act on it by your own rules.`,
    );
    expect(line).toBe('Wait for a run ended: it was cancelled.');
    expect(statusLine).toContain('status: cancelled');
  });

  it('names the latest resolution of an Action Center item, as its last status line says', () => {
    const statusLine = '2026-11-06T08:01:00.000Z (resolution: approve)';
    const line = describeWaitOutcomeNotice(
      'Your wait 23e0cfeb-0000-4000-8000-000000000339 on gate.resolved on item-1 has ended: ' +
        'the event arrived at 2026-11-06T08:00:00.000Z (resolution: reassign). ' +
        `Later events on the subject before you were told: ${statusLine}. Act on it by your own rules.`,
    );
    expect(line).toBe('Wait for an Action Center item ended: it was approved.');
    expect(statusLine).toContain('resolution: approve');
  });

  it('names how a run ended', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on run.ended on run-1 has ended: ' +
          'the event arrived at 2026-11-06T08:00:00.000Z (status: completed). Act on it by your own rules.',
      ),
    ).toBe('Wait for a run ended: it completed.');
  });

  it('names how an Action Center item was resolved', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on gate.resolved on item-1 has ended: ' +
          'the event arrived at 2026-11-06T08:00:00.000Z (resolution: approve). Act on it by your own rules.',
      ),
    ).toBe('Wait for an Action Center item ended: it was approved.');
  });

  it('names a plan step by its title and its new status', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on plan.node.status_changed on node-1 has ended: ' +
          'the event arrived at 2026-11-06T08:00:00.000Z (status: active, previousStatus: blocked). Act on it by your own rules.' +
          '\n\nPlan node "Ship the release" (node-1) is now active, at revision 4.\nIt has no note.',
      ),
    ).toBe('Wait for plan step “Ship the release” ended: it is now active.');
  });

  it('names the status the body names where the node moved again before delivery', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on plan.node.status_changed on node-1 has ended: ' +
          'the event arrived at 2026-11-06T08:00:00.000Z (status: active, previousStatus: blocked). ' +
          'Later events on the subject before you were told: 2026-11-06T08:01:00.000Z (status: done, previousStatus: active). ' +
          'Act on it by your own rules.' +
          '\n\nPlan node "Ship the release" (node-1) is now done, at revision 5.\nIt has no note.',
      ),
    ).toBe('Wait for plan step “Ship the release” ended: it is now done.');
  });

  it('names the status a plan step moved to when its window closed on a lost event', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on plan.node.status_changed on node-1 has ended: ' +
          'its window closed at 2026-11-06T08:00:00.000Z with no event. Read the subject yourself before you act.' +
          '\n\nPlan node "Ship the release" (node-1) is now active, at revision 4.\nIt has no note.',
      ),
    ).toBe('Wait for plan step “Ship the release” ended: it is now active.');
  });

  it('says a plan step no longer exists when the body says so', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on plan.node.status_changed on node-1 has ended: ' +
          'its window closed at 2026-11-06T08:00:00.000Z with no event. Read the subject yourself before you act.' +
          '\n\nPlan node node-1 no longer exists.',
      ),
    ).toBe('Wait for a plan step ended: it no longer exists.');
  });

  it('reads the status line, not a note that holds the words of another', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on plan.node.status_changed on node-1 has ended: ' +
          'its window closed at 2026-11-06T08:00:00.000Z with no event. Read the subject yourself before you act.' +
          '\n\nPlan node "Ship the release" (node-1) is now active, at revision 4.\nIts note:\n' +
          'Plan node node-0 no longer exists.\n' +
          'Plan node "Old step" (node-0) is now cancelled, at revision 9.',
      ),
    ).toBe('Wait for plan step “Ship the release” ended: it is now active.');
  });

  it('says the time ran out when the window closed', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on gate.resolved on item-1 has ended: ' +
          'its window closed at 2026-11-06T08:00:00.000Z with no event. Read the subject yourself before you act.',
      ),
    ).toBe('Wait for an Action Center item ended: its time ran out with no news.');
  });

  it('still reads as a wait that ended when the words are not recognised', () => {
    expect(describeWaitOutcomeNotice('Something the platform said.')).toBe('A wait ended.');
  });
});

describe('isWaitOutcomeMessage', () => {
  it('is a room message the platform posted as the wait actor, and nothing else', () => {
    expect(isWaitOutcomeMessage({ role: 'user', authorUserId: WAIT_OUTCOME_ACTOR_ID })).toBe(true);
    expect(isWaitOutcomeMessage({ role: 'user', authorUserId: 'person-1' })).toBe(false);
    expect(isWaitOutcomeMessage({ role: 'user' })).toBe(false);
    expect(isWaitOutcomeMessage({ role: 'assistant', authorUserId: WAIT_OUTCOME_ACTOR_ID })).toBe(
      false,
    );
  });
});
