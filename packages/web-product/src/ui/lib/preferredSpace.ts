import { cookies } from 'next/headers';
import { SpaceSlugSchema } from '@aflow/schemas';

export { PREFERRED_SPACE_COOKIE } from '../../preferredSpaceCookie.js';
import { PREFERRED_SPACE_COOKIE } from '../../preferredSpaceCookie.js';

/** 90 days in seconds. */
const PREFERRED_SPACE_MAX_AGE_SEC = 60 * 60 * 24 * 90;

/**
 * Read the preferred-space slug from the request cookies. Returns `null`
 * when the cookie is absent, empty, or fails {@link SpaceSlugSchema}.
 *
 * Callers using this on `/` for a redirect should still validate the
 * returned slug against the user's accessible spaces — a cookie can
 * point at a space the user has lost access to since it was set, in
 * which case fall back to the first accessible slug.
 */
export async function getPreferredSpaceSlug(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(PREFERRED_SPACE_COOKIE)?.value;
  if (!raw) return null;
  const parsed = SpaceSlugSchema.safeParse(raw);
  return parsed.success ? (parsed.data as string) : null;
}

/**
 * Write the preferred-space slug to the response cookies. Throws if
 * `slug` fails {@link SpaceSlugSchema} — the caller is expected to be
 * inside a `/s/[space]/...` layout where the route param is guaranteed
 * to be a valid slug, so a throw here flags an upstream bug rather than
 * a user error.
 *
 * Callable from Server Components, Server Actions, and Route Handlers
 * — anywhere `cookies()` is writable.
 */
export async function setPreferredSpaceSlug(slug: string): Promise<void> {
  const parsed = SpaceSlugSchema.parse(slug);
  const store = await cookies();
  store.set({
    name: PREFERRED_SPACE_COOKIE,
    value: parsed,
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: PREFERRED_SPACE_MAX_AGE_SEC,
  });
}

/**
 * Clear the preferred-space cookie. Used on logout or when the user
 * explicitly opts out (e.g. "always land on space picker").
 */
export async function clearPreferredSpaceSlug(): Promise<void> {
  const store = await cookies();
  store.delete(PREFERRED_SPACE_COOKIE);
}
