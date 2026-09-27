/**
 * The product's server-side user-interface helpers.
 *
 * Separate from `./ui` because that barrel is what client components import, and
 * a module here reaches for `next/headers` — a request-scoped API that exists
 * only in a server component. Re-exporting one through the client barrel drags it
 * into every browser bundle that imports anything at all, which fails the build
 * with a message about the Pages Router that names neither the module nor the
 * import that pulled it in.
 */
export { getPreferredSpaceSlug } from './lib/preferredSpace.js';
export {
  PREFERRED_SPACE_COOKIE,
  clearPreferredSpaceSlug,
  setPreferredSpaceSlug,
} from './lib/preferredSpace.js';
export { enterPreferredSpace, resolveSpaceEntry } from './lib/enter-preferred-space.js';
export type { SpaceLookup, SpaceLookupOutcome } from './lib/enter-preferred-space.js';
