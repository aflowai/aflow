/**
 * Which notice a 401 earns on a local instance. A profile session the API
 * refused is not a secret the web process and the API disagree on.
 */
import { describe, expect, it } from 'vitest';

import {
  INSTANCE_SECRET_MESSAGE,
  PROFILE_SESSION_MESSAGE,
  localRecovery,
} from './localRecovery.js';

describe('the local recovery notice', () => {
  it.each(['PROFILE_SESSION_REQUIRED', 'PROFILE_SESSION_INVALID'])(
    'says the profile session is missing or ended on %s',
    (code) => {
      expect(localRecovery.resolve('/chat', code)).toEqual({
        kind: 'message',
        message: PROFILE_SESSION_MESSAGE,
      });
    },
  );

  it.each([null, 'SOMETHING_ELSE'])('blames the instance secret on any other 401 (%s)', (code) => {
    expect(localRecovery.resolve('/chat', code)).toEqual({
      kind: 'message',
      message: INSTANCE_SECRET_MESSAGE,
    });
  });
});
