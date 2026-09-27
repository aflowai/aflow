/**
 * Two people in one session must read as two people: the agent gets a roster
 * once a second person appears, and the steer that woke it carries its
 * author's name. A session of one keeps its turns byte-identical — no roster
 * block, no attribution prefix.
 */
import { describe, it, expect } from 'vitest';
import type { RoomSpeaker } from '@aflow/schemas';
import type { SessionParticipant } from '@aflow/redis';
import { buildSessionParticipantsBlock, resolveSteeringAuthor } from '../agentTurn.js';

const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

const sara: SessionParticipant = { userId: SARA, displayName: 'Sara' };
const karim: SessionParticipant = { userId: KARIM, displayName: 'Karim' };
const speaker: RoomSpeaker = { actorUserId: SARA, actorDisplayName: 'Sara' };

describe('buildSessionParticipantsBlock', () => {
  it('withholds the block for a session of one', () => {
    expect(buildSessionParticipantsBlock(undefined)).toBeUndefined();
    expect(buildSessionParticipantsBlock([])).toBeUndefined();
    expect(buildSessionParticipantsBlock([sara])).toBeUndefined();
  });

  it('lists everyone and says how to read attribution once a second person appears', () => {
    const block = buildSessionParticipantsBlock([karim, sara]);

    expect(block?.key).toBe('SessionParticipants');
    expect(block?.content).toEqual({
      participants: [
        { userId: KARIM, displayName: 'Karim' },
        { userId: SARA, displayName: 'Sara' },
      ],
      guidance:
        "Messages are attributed by name when more than one person is present; the 'user' in FlowRunContext is whoever last steered, not the only participant.",
    });
  });

  it('keeps a nameless participant as their id rather than dropping them', () => {
    const block = buildSessionParticipantsBlock([karim, { userId: SARA }]);
    expect(block?.content).toMatchObject({
      participants: [{ userId: KARIM, displayName: 'Karim' }, { userId: SARA }],
    });
  });
});

describe('resolveSteeringAuthor', () => {
  it('a solo session steers without attribution — the turn stays byte-identical', () => {
    expect(resolveSteeringAuthor(speaker, [sara])).toBeUndefined();
    expect(resolveSteeringAuthor(speaker, [])).toBeUndefined();
    expect(resolveSteeringAuthor(speaker, undefined)).toBeUndefined();
  });

  it('a second participant makes the steer carry its author', () => {
    expect(resolveSteeringAuthor(speaker, [karim, sara])).toBe(speaker);
  });

  it('a turn nobody spoke for stays unattributed however many are present', () => {
    expect(resolveSteeringAuthor(undefined, [karim, sara])).toBeUndefined();
  });
});
