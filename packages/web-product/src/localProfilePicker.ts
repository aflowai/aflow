/**
 * Where the local edition's profile picker answers (Plan 335 P3), and how it
 * asks for a locked profile's PIN (P4).
 *
 * Its own module, importing nothing, because the local application's route
 * handler and the product's client components both read these.
 */

/** The picker a browser opens to switch profile. */
export const LOCAL_PROFILE_PICKER_PATH = '/profiles';

/** Where a tile posts the profile it names. The web process issues the session there. */
export const LOCAL_PROFILE_CHOICE_PATH = '/profiles/choose';

/** The form field that carries the chosen profile's user id. */
export const LOCAL_PROFILE_CHOICE_FIELD = 'userId';

/** The form field that carries the PIN of a locked profile (Plan 335 P4). */
export const LOCAL_PROFILE_PIN_FIELD = 'pin';

/** The picker's query naming the locked profile whose PIN it asks for. */
export const LOCAL_PROFILE_UNLOCK_PARAM = 'unlock';

/** The picker's query saying why the PIN let nothing through. */
export const LOCAL_PROFILE_PIN_ERROR_PARAM = 'pin';

/**
 * The picker's query saying when a throttled profile may be tried again, in
 * Unix seconds. The page counts the remaining wait from it on each load.
 */
export const LOCAL_PROFILE_PIN_UNTIL_PARAM = 'until';

/** Why the PIN prompt shows again. */
export type LocalProfilePinError = 'required' | 'incorrect' | 'throttled';

/** The picker, asking for one locked profile's PIN. */
export function localProfileUnlockHref(
  userId: string,
  error?: LocalProfilePinError,
  retryAtSec?: number,
): string {
  const query = new URLSearchParams({ [LOCAL_PROFILE_UNLOCK_PARAM]: userId });
  if (error !== undefined) query.set(LOCAL_PROFILE_PIN_ERROR_PARAM, error);
  if (retryAtSec !== undefined) query.set(LOCAL_PROFILE_PIN_UNTIL_PARAM, String(retryAtSec));
  return `${LOCAL_PROFILE_PICKER_PATH}?${query.toString()}`;
}
