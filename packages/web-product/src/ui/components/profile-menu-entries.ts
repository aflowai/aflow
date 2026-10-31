/**
 * What the local edition's footer menu offers (Plan 335 D2): the other
 * profiles to switch to, the picker, Settings → Profiles for the owner, and
 * the account page.
 */
import { showsLocalProfilePicker, type LocalProfileChoice } from '@aflow/schemas';
import { LOCAL_PROFILE_PICKER_PATH } from '@aflow/web-product';

export type ProfileMenuEntry =
  | { kind: 'switch-to'; profile: LocalProfileChoice }
  | { kind: 'link'; label: string; href: string };

export const MANAGE_PROFILES_HREF = '/settings/profiles';
export const ACCOUNT_SETTINGS_HREF = '/account';

/**
 * `profiles` is null while the list is unread. An unread list offers no
 * switch, and neither does an install with one profile.
 */
export function profileMenuEntries(input: {
  currentUserId: string;
  isOwner: boolean;
  profiles: readonly LocalProfileChoice[] | null;
}): ProfileMenuEntry[] {
  const entries: ProfileMenuEntry[] = [];
  if (input.profiles !== null && showsLocalProfilePicker(input.profiles)) {
    for (const profile of input.profiles) {
      if (profile.userId !== input.currentUserId) entries.push({ kind: 'switch-to', profile });
    }
    entries.push({ kind: 'link', label: 'Switch profile', href: LOCAL_PROFILE_PICKER_PATH });
  }
  if (input.isOwner) {
    entries.push({ kind: 'link', label: 'Manage profiles', href: MANAGE_PROFILES_HREF });
  }
  entries.push({ kind: 'link', label: 'Account settings', href: ACCOUNT_SETTINGS_HREF });
  return entries;
}
