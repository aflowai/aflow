/**
 * Where the local edition's profile picker answers (Plan 335 P3).
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
