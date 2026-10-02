/**
 * The browser profiles this machine offers.
 *
 * A policy that never mentioned browsers still gets one: where a supported
 * Chrome is installed, the `default` profile, open to every space. It is
 * computed here each time the policy is read and never written into the file,
 * so the file says only what the operator said, and the moment they declare
 * profiles of their own those are the whole set.
 */
import {
  type BrowserProfile,
  BrowserProfileSchema,
  DEFAULT_BROWSER_PROFILE_ID,
} from '@aflow/schemas';

import type { ChromeDiscovery } from './chromeDiscovery.js';

/** The scope a profile's browser is reaped under, in the namespace binding ids use. */
export function browserProfileScope(profileId: string): string {
  return `browser-profile:${profileId}`;
}

export function effectiveBrowserProfiles(
  declared: readonly BrowserProfile[] | undefined,
  chrome: ChromeDiscovery,
): Map<string, BrowserProfile> {
  if (declared !== undefined) return new Map(declared.map((profile) => [profile.id, profile]));
  if (chrome.found === undefined) return new Map();
  const implied = BrowserProfileSchema.parse({ id: DEFAULT_BROWSER_PROFILE_ID });
  return new Map([[implied.id, implied]]);
}

/** Whether a run in `spaceId` may use the profile. A run that names no space may use none closed to some. */
export function profileOpenToSpace(profile: BrowserProfile, spaceId: string | undefined): boolean {
  if (profile.spaces === 'all') return true;
  return spaceId !== undefined && profile.spaces.includes(spaceId);
}
