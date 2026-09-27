/**
 * What the gateway said about a refusal has to survive the trip into the
 * iframe. The 422 body carries a hand-written message, the reason slug, the
 * declared surface and any structural failures; a bridge that forwards only
 * the last of those leaves five of six refusal kinds with nothing to say.
 */
import { describe, expect, it } from 'vitest';
import { APPLET_REFUSAL_MESSAGE_MAX_LENGTH } from '@aflow/schemas';
import { readRefusalDetail } from './applet-refusal';

describe('readRefusalDetail', () => {
  it('carries the guard message the gateway wrote', () => {
    expect(
      readRefusalDetail({
        reason: 'guard_rejected',
        message:
          'No clip sits at fromIndex on that track — read the timeline and pass the position the clip is actually at.',
        availableActions: ['move_clip', 'set_title'],
      }),
    ).toEqual({
      reason: 'guard_rejected',
      message:
        'No clip sits at fromIndex on that track — read the timeline and pass the position the clip is actually at.',
      availableActions: ['move_clip', 'set_title'],
    });
  });

  it('carries a 403 body, which names no reason', () => {
    expect(
      readRefusalDetail({
        error: 'Forbidden',
        message: 'Viewers cannot act on an applet instance',
      }),
    ).toEqual({ message: 'Viewers cannot act on an applet instance' });
  });

  it('keeps structural failures alongside the message', () => {
    expect(
      readRefusalDetail({
        reason: 'invalid_input',
        message: 'The action input does not match its declared schema',
        validation: ['fromIndex: expected number'],
      })['validation'],
    ).toEqual(['fromIndex: expected number']);
  });

  it('drops a reason that is not a slug and a message that is not a string', () => {
    expect(readRefusalDetail({ reason: 'Guard Rejected!', message: 42 })).toEqual({});
  });

  it('bounds the message at the wire cap', () => {
    const detail = readRefusalDetail({
      message: 'x'.repeat(APPLET_REFUSAL_MESSAGE_MAX_LENGTH * 2),
    });
    expect(detail['message']).toHaveLength(APPLET_REFUSAL_MESSAGE_MAX_LENGTH);
  });

  it('says nothing about a body it cannot read', () => {
    expect(readRefusalDetail(undefined)).toEqual({});
    expect(readRefusalDetail('nope')).toEqual({});
  });
});
