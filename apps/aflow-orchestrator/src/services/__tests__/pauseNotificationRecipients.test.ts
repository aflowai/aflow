/**
 * Who gets told when a run stops for a person. The rule under test: targeting
 * decides, a role reaches everyone holding it, an untargeted pause falls back
 * to the initiator alone, and nobody outside the space is ever told.
 */
import { describe, it, expect } from 'vitest';
import type { SessionHotState } from '@aflow/redis';
import { deriveRecipients, pauseRequestSubject } from '../pauseNotificationRouter.js';

const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';
const ALEX = '00000000-0000-4000-8000-00000000a1e0';

const members = [
  { userId: SARA, role: 'admin' },
  { userId: KARIM, role: 'editor' },
  { userId: ALEX, role: 'editor' },
];

describe('deriveRecipients', () => {
  it('a named person is told, and only them', () => {
    expect(deriveRecipients({ candidateResolvers: [SARA], members, createdBy: KARIM })).toEqual([
      SARA,
    ]);
  });

  it('a named role reaches everyone holding it', () => {
    expect(
      deriveRecipients({ candidateResolvers: ['editor'], members, createdBy: SARA }).sort(),
    ).toEqual([ALEX, KARIM].sort());
  });

  it('names and roles mix without telling anyone twice', () => {
    const got = deriveRecipients({
      candidateResolvers: [KARIM, 'editor'],
      members,
      createdBy: SARA,
    });
    expect(got.sort()).toEqual([ALEX, KARIM].sort());
  });

  it('an untargeted pause falls back to whoever started the run', () => {
    expect(deriveRecipients({ candidateResolvers: undefined, members, createdBy: KARIM })).toEqual([
      KARIM,
    ]);
  });

  it('never tells someone outside the space', () => {
    const stranger = '00000000-0000-4000-8000-00000000dead';
    expect(
      deriveRecipients({ candidateResolvers: [stranger], members, createdBy: stranger }),
    ).toEqual([]);
  });

  it('a target that can reach nobody falls back to the initiator', () => {
    // The named person left the space, so the run would otherwise sit stuck
    // with nobody told at all — the one outcome async supervision exists to
    // prevent. The initiator is not being asked to answer; they are being
    // told their run cannot proceed.
    const stranger = '00000000-0000-4000-8000-00000000dead';
    expect(deriveRecipients({ candidateResolvers: [stranger], members, createdBy: KARIM })).toEqual(
      [KARIM],
    );
  });
});

describe('what a person is told about', () => {
  const approvalRef = 'inline:eyJyZWFzb24iOiJhcHByb3ZhbCJ9';

  it('is the request, so a delegated pause tells them once', () => {
    // A delegated pause rests in two places: the child asks, and the parent
    // copies the same requestedInputRef onto its own delegate step. Both are
    // PAUSED, both flush, and each is a different session on a different step
    // execution — keyed by step that is two rows and one person pinged twice
    // for one question. Keyed by the request they collapse, however deep the
    // chain goes.
    const child = {
      sessionId: 'child-session',
      currentStepExecutionId: 'child-step',
      requestedInputRef: approvalRef,
    } as SessionHotState;
    const parent = {
      sessionId: 'parent-session',
      currentStepExecutionId: 'parent-delegate-step',
      requestedInputRef: approvalRef,
    } as SessionHotState;

    expect(pauseRequestSubject(parent)).toBe(pauseRequestSubject(child));
  });

  it('still separates two genuinely different questions', () => {
    const first = { requestedInputRef: approvalRef } as SessionHotState;
    const second = { requestedInputRef: 'inline:eyJyZWFzb24iOiJpbnB1dCJ9' } as SessionHotState;

    expect(pauseRequestSubject(first)).not.toBe(pauseRequestSubject(second));
  });
});
