import { describe, expect, it } from 'vitest';
import {
  buildSessionParticipantsBlock,
  resolveSteeringAuthor,
  resolveTurnSpeaker,
} from './sessionRoster.js';

const KARIM = { userId: 'u-karim', displayName: 'Karim Mansi', status: 'joined' as const };
const JOHNNY = { userId: 'u-johnny', displayName: 'Johnny Appleseed', status: 'joined' as const };

describe('resolveTurnSpeaker', () => {
  it('the hot-state actor beats the event-log speaker — the log lags the freshest hand-off', () => {
    // Johnny resumed with a message; the durable log has not flushed his
    // SessionResumed yet, so its latest speaker is still Karim. Labeling by
    // the log put Karim's name on Johnny's message in a live game.
    const speaker = resolveTurnSpeaker(
      { id: JOHNNY.userId, name: 'johnny@example' },
      [KARIM, JOHNNY],
      { actorUserId: KARIM.userId, actorDisplayName: KARIM.displayName },
    );
    expect(speaker).toEqual({
      actorUserId: JOHNNY.userId,
      actorDisplayName: JOHNNY.displayName,
    });
  });

  it('prefers the roster display name over the raw context name, and falls back in order', () => {
    const rosterless = resolveTurnSpeaker({ id: JOHNNY.userId, name: 'Johnny A.' }, [], {
      actorUserId: KARIM.userId,
    });
    expect(rosterless).toEqual({ actorUserId: JOHNNY.userId, actorDisplayName: 'Johnny A.' });
    const nameless = resolveTurnSpeaker({ id: JOHNNY.userId }, undefined, undefined);
    expect(nameless).toEqual({ actorUserId: JOHNNY.userId });
  });

  it('without a hot-state actor the log speaker stands', () => {
    const speaker = resolveTurnSpeaker(undefined, [KARIM, JOHNNY], {
      actorUserId: KARIM.userId,
      actorDisplayName: KARIM.displayName,
    });
    expect(speaker).toEqual({ actorUserId: KARIM.userId, actorDisplayName: KARIM.displayName });
  });
});

describe('resolveSteeringAuthor', () => {
  it('attribution exists only when there is more than one person', () => {
    const speaker = { actorUserId: JOHNNY.userId, actorDisplayName: JOHNNY.displayName };
    expect(resolveSteeringAuthor(speaker, [KARIM, JOHNNY])).toEqual(speaker);
    expect(resolveSteeringAuthor(speaker, [JOHNNY])).toBeUndefined();
    expect(resolveSteeringAuthor(undefined, [KARIM, JOHNNY])).toBeUndefined();
  });
});

describe('buildSessionParticipantsBlock', () => {
  it('marks invited members as expected, not present', () => {
    const block = buildSessionParticipantsBlock([
      KARIM,
      { userId: 'u-sara', displayName: 'Sara', status: 'invited' },
    ]);
    expect(block).toBeDefined();
    const content = block!.content as { participants: Array<Record<string, unknown>> };
    expect(content.participants[1]).toEqual({
      userId: 'u-sara',
      displayName: 'Sara',
      status: 'invited (has not joined yet)',
    });
  });

  it('a room of one gets no block — solo turns stay byte-identical', () => {
    expect(buildSessionParticipantsBlock([KARIM])).toBeUndefined();
  });
});
