/**
 * The local footer menu (Plan 335 D2) offers a switch only where the install
 * has a second profile, and Settings → Profiles only to the owner.
 */
import { describe, expect, it } from 'vitest';
import type { LocalProfileChoice } from '@aflow/schemas';

import { profileMenuEntries } from './profile-menu-entries.js';

const OWNER: LocalProfileChoice = {
  userId: '00000000-0000-4000-8000-0000000ed1c1',
  displayName: 'Local user',
  avatar: null,
  isOwner: true,
  hasPin: false,
};
const ADA: LocalProfileChoice = {
  userId: '00000000-0000-4000-8000-00000000a0a0',
  displayName: 'Ada',
  avatar: 'owl',
  isOwner: false,
  hasPin: false,
};

const labels = (entries: ReturnType<typeof profileMenuEntries>): string[] =>
  entries.map((entry) =>
    entry.kind === 'link' ? entry.label : `Switch to ${entry.profile.displayName}`,
  );

describe('the footer profile menu', () => {
  it('offers no switch on an install with one profile', () => {
    expect(
      labels(profileMenuEntries({ currentUserId: OWNER.userId, isOwner: true, profiles: [OWNER] })),
    ).toEqual(['Manage profiles', 'Account settings']);
  });

  // Plan 335 P4: a PIN on the only profile gives the menu nobody to switch to.
  it('offers no switch on an install with one profile locked with a PIN', () => {
    expect(
      labels(
        profileMenuEntries({
          currentUserId: OWNER.userId,
          isOwner: true,
          profiles: [{ ...OWNER, hasPin: true }],
        }),
      ),
    ).toEqual(['Manage profiles', 'Account settings']);
  });

  it('offers no switch while the profiles are unread', () => {
    expect(
      labels(profileMenuEntries({ currentUserId: OWNER.userId, isOwner: true, profiles: null })),
    ).toEqual(['Manage profiles', 'Account settings']);
  });

  it('lists the other profiles and the picker once a second profile exists', () => {
    expect(
      labels(
        profileMenuEntries({ currentUserId: OWNER.userId, isOwner: true, profiles: [OWNER, ADA] }),
      ),
    ).toEqual(['Switch to Ada', 'Switch profile', 'Manage profiles', 'Account settings']);
  });

  it('withholds Settings → Profiles from a profile that is not the owner', () => {
    const entries = profileMenuEntries({
      currentUserId: ADA.userId,
      isOwner: false,
      profiles: [OWNER, ADA],
    });
    expect(labels(entries)).toEqual(['Switch to Local user', 'Switch profile', 'Account settings']);
    expect(entries).toContainEqual({ kind: 'link', label: 'Switch profile', href: '/profiles' });
  });
});
