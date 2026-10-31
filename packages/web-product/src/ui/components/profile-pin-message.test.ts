/**
 * Plan 335 P4: a throttled PIN prompt names the wait the API answered.
 */
import { describe, expect, it } from 'vitest';
import { localProfilePinErrorMessage } from './profile-pin-message.js';

describe('the PIN prompt message', () => {
  it('names the wait the API answered, in seconds and then in minutes', () => {
    const throttled = (retryAfterSec: number | null) =>
      localProfilePinErrorMessage({ error: 'throttled', retryAfterSec });
    expect(throttled(1)).toBe('Too many wrong PINs. Try again in 1 second.');
    expect(throttled(30)).toBe('Too many wrong PINs. Try again in 30 seconds.');
    expect(throttled(60)).toBe('Too many wrong PINs. Try again in 1 minute.');
    expect(throttled(61)).toBe('Too many wrong PINs. Try again in 2 minutes.');
    expect(throttled(15 * 60)).toBe('Too many wrong PINs. Try again in 15 minutes.');
    expect(throttled(null)).toBe('Too many wrong PINs. Wait, then try again.');
  });

  it('asks again for a missing or wrong PIN', () => {
    expect(localProfilePinErrorMessage({ error: 'required', retryAfterSec: null })).toBe(
      'Enter the PIN for this profile.',
    );
    expect(localProfilePinErrorMessage({ error: 'incorrect', retryAfterSec: null })).toBe(
      'That PIN is not right. Try again.',
    );
  });
});
