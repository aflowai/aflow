/**
 * The cookie naming the space a visitor last used.
 *
 * Its own module, importing nothing: the Next middleware needs the name and runs
 * on every request, so reaching it through a barrel would pull that barrel's
 * whole graph into the bundle ahead of every page.
 */
export const PREFERRED_SPACE_COOKIE = 'preferredSpaceSlug';
