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

  it('names how a run ended', () => {
    expect(
      describeWaitOutcomeNotice(
        'Your wait 23e0cfeb-0000-4000-8000-000000000339 on run.ended on run-1 has ended: ' +
          'the event arrived at 2026-11-06T08:00:00.000Z (status: completed). Act on it by your own rules.',
      ),
    ).toBe('Wait for a run ended: it completed.');
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
