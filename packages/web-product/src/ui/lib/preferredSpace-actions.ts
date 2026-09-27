'use server';

/**
 * Server actions for the preferred-space cookie.
 *
 * Split from `lib/preferredSpace.ts` because the read/write helpers
 * there are imported by both server components (the cold-load redirect
 * at `/`) and client code. Mixing `'use server'` and plain async
 * exports in the same file is invalid in Next.js App Router; the
 * server-actions live here so the read-only helpers can keep being
 * imported anywhere without dragging in the RSC action serializer.
 */
import { setPreferredSpaceSlug, clearPreferredSpaceSlug } from './preferredSpace';

/**
 * Set the preferred-space cookie to `slug`. Callers are expected to
 * have already confirmed the slug points at a space the user can
 * access (typically via the client-side `SpaceDataContext.spaces`
 * list). This action does no membership check — it only re-validates
 * the slug shape inside {@link setPreferredSpaceSlug}.
 */
export async function persistPreferredSpaceSlugAction(slug: string): Promise<void> {
  await setPreferredSpaceSlug(slug);
}

/** Clear the preferred-space cookie. */
export async function clearPreferredSpaceSlugAction(): Promise<void> {
  await clearPreferredSpaceSlug();
}
