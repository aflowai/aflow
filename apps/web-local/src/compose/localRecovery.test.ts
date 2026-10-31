/**
 * What a 401 earns on a local instance. A profile session the API refused is
 * not a secret the web process and the API disagree on, so it sends the
 * browser to the picker at the front door (Plan 335 P3).
 */
import { describe, expect, it } from 'vitest';

import {
  INSTANCE_SECRET_MESSAGE,
  isProfileSessionRefusal,
  localRecovery,
} from './localRecovery.js';

describe('the local recovery', () => {
  it.each(['PROFILE_SESSION_REQUIRED', 'PROFILE_SESSION_INVALID'])(
    'sends the browser to the picker on %s',
    (code) => {
      expect(isProfileSessionRefusal(code)).toBe(true);
      expect(localRecovery.resolve('/chat', code)).toEqual({ kind: 'redirect', href: '/' });
    },
  );

  it.each([null, 'SOMETHING_ELSE'])('blames the instance secret on any other 401 (%s)', (code) => {
    expect(isProfileSessionRefusal(code)).toBe(false);
    expect(localRecovery.resolve('/chat', code)).toEqual({
      kind: 'message',
      message: INSTANCE_SECRET_MESSAGE,
    });
  });
});
