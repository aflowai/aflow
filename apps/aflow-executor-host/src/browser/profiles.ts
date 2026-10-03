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
import { chromeMissingMessage, type ChromeDiscovery } from './chromeDiscovery.js';
import { BrowserDriverError } from './errors.js';

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

/** What a profile is looked up in: the profiles in effect, those disabled, and the browser found. */
export interface BrowserPolicy {
  readonly browsers: ReadonlyMap<string, BrowserProfile>;
  /** Profiles the policy declares that did not parse, by id, with the schema's reason. */
  readonly invalidBrowsers: ReadonlyMap<string, string>;
  readonly chrome: ChromeDiscovery;
}

export function listedIds(ids: readonly string[]): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : 'none';
}

/** The browser to start, or the refusal that says where one was looked for. */
export function chromeExecutable(policy: BrowserPolicy): string {
  const executable = policy.chrome.found?.path;
  if (executable === undefined) {
    throw new BrowserDriverError('no_browser', chromeMissingMessage(policy.chrome));
  }
  return executable;
}

/**
 * The profile a run asked for, refused when the run's space may not use it —
 * unless the machine itself is asking, as the operator's sign-in does.
 */
export function resolveProfile(
  policy: BrowserPolicy,
  profileId: string,
  spaceId: string | undefined,
  onMachine = false,
): BrowserProfile {
  const profile = policy.browsers.get(profileId);
  if (profile === undefined) {
    const invalid = policy.invalidBrowsers.get(profileId);
    if (invalid !== undefined) {
      throw new BrowserDriverError(
        'profile_invalid',
        `Browser profile \`${profileId}\` is declared on this machine but is not valid, so it ` +
          'is disabled; the other profiles are unaffected, and the operator corrects it in the ' +
          `host policy. What is wrong with it: ${invalid}`,
      );
    }
    if (policy.browsers.size === 0 && policy.chrome.found === undefined) {
      throw new BrowserDriverError('no_browser', chromeMissingMessage(policy.chrome));
    }
    throw new BrowserDriverError(
      'unknown_profile',
      `This machine has no browser profile \`${profileId}\`. Profiles configured here: ` +
        `${listedIds([...policy.browsers.keys()])}. A profile is declared on the machine; a run ` +
        'cannot add one.',
    );
  }
  if (!onMachine && !profileOpenToSpace(profile, spaceId)) {
    const open = [...policy.browsers.values()]
      .filter((candidate) => profileOpenToSpace(candidate, spaceId))
      .map((candidate) => candidate.id);
    throw new BrowserDriverError(
      'profile_not_for_space',
      `Browser profile \`${profileId}\` is not open to this space. Profiles this space may ` +
        `use: ${listedIds(open)}. Which spaces a profile serves is set on the machine.`,
    );
  }
  return profile;
}
