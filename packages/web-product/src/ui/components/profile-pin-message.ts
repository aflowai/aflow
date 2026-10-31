/**
 * What the PIN prompt says when it shows again (Plan 335 P4). A throttled
 * profile names the wait the API answered, which runs from 30 seconds to 15
 * minutes.
 */
import type { LocalProfilePinError } from '@aflow/web-product';

/** Why the PIN prompt shows again, and for a throttled profile the seconds still to wait. */
export interface LocalProfilePinRefusal {
  error: LocalProfilePinError;
  /** Null when the API named no wait. */
  retryAfterSec: number | null;
}

function waitPhrase(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

export function localProfilePinErrorMessage({
  error,
  retryAfterSec,
}: LocalProfilePinRefusal): string {
  switch (error) {
    case 'required':
      return 'Enter the PIN for this profile.';
    case 'incorrect':
      return 'That PIN is not right. Try again.';
    case 'throttled':
      return retryAfterSec === null
        ? 'Too many wrong PINs. Wait, then try again.'
        : `Too many wrong PINs. Try again in ${waitPhrase(retryAfterSec)}.`;
  }
}
