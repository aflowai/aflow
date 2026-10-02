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

import { describePolicyIssues } from '../policyIssues.js';
import type { ChromeDiscovery } from './chromeDiscovery.js';

export interface DeclaredBrowserProfiles {
  readonly profiles: readonly BrowserProfile[];
  /** Declared profiles that did not parse, by the id each was given, with why. */
  readonly invalid: ReadonlyMap<string, string>;
}

/**
 * Each profile is parsed on its own, so one the schema refuses disables that
 * profile and nothing beside it. An id given twice disables every profile
 * giving it: which one the operator meant is not something to guess.
 */
export function parseBrowserProfiles(entries: readonly unknown[]): DeclaredBrowserProfiles {
  const invalid = new Map<string, string>();
  const parsed: BrowserProfile[] = [];
  const timesGiven = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const given = (entry as { id?: unknown } | null)?.id;
    const id = typeof given === 'string' ? given : `browsers.${index}`;
    timesGiven.set(id, (timesGiven.get(id) ?? 0) + 1);
    const result = BrowserProfileSchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
    else invalid.set(id, describePolicyIssues(result.error));
  }
  for (const [id, times] of timesGiven) {
    if (times > 1)
      invalid.set(id, `id: \`${id}\` is given to ${times} profiles; each id appears once.`);
  }
  return { profiles: parsed.filter((profile) => !invalid.has(profile.id)), invalid };
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
