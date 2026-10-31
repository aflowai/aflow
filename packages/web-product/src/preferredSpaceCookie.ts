/**
 * The cookie naming the space a visitor last used.
 *
 * Its own module, importing nothing: the Next middleware needs the name and runs
 * on every request, so reaching it through a barrel would pull that barrel's
 * whole graph into the bundle ahead of every page.
 */
export const PREFERRED_SPACE_COOKIE = 'preferredSpaceSlug';

/**
 * The local profile this browser chose at the picker (Plan 335 P3). Only the
 * local edition's picker sets it, beside the profile session. It is a hint
 * that keys the preferred space and authorizes nothing: the API reads the
 * session, never this.
 */
export const ACTIVE_PROFILE_COOKIE = 'aflow_profile';

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The preferred-space cookie for one profile, so each profile lands in its own
 * space after a switch. A browser that chose no profile keeps the one name.
 */
export function preferredSpaceCookieName(profileId: string | null | undefined): string {
  if (profileId === null || profileId === undefined || !PROFILE_ID.test(profileId)) {
    return PREFERRED_SPACE_COOKIE;
  }
  return `${PREFERRED_SPACE_COOKIE}.${profileId.toLowerCase()}`;
}
