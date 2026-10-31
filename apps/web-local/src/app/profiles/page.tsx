import { redirect } from 'next/navigation';
import {
  LOCAL_PROFILE_PIN_ERROR_PARAM,
  LOCAL_PROFILE_UNLOCK_PARAM,
  showsLocalProfilePicker,
} from '@aflow/web-product';
import { ProfilePicker } from '@aflow/web-product/ui';

import {
  CHOICE_FAILED_MESSAGE,
  CHOICE_FAILED_PARAM,
  readProfileChoices,
  unlockingFrom,
} from '@/compose/localProfileSession';

export const dynamic = 'force-dynamic';

/**
 * Switch profile: the picker, opened from the footer menu (Plan 335 D2), and
 * the PIN prompt a locked profile's tile opens (P4).
 *
 * An install with one profile and no PIN has nothing to choose, so this page
 * sends it to the front door. One locked profile still has a PIN to ask for.
 */
export default async function SwitchProfile({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profiles = await readProfileChoices();
  if (profiles === null || !showsLocalProfilePicker(profiles)) redirect('/');
  const params = await searchParams;
  const failed = params[CHOICE_FAILED_PARAM] !== undefined;
  return (
    <ProfilePicker
      profiles={profiles}
      notice={failed ? CHOICE_FAILED_MESSAGE : null}
      backHref="/"
      unlocking={unlockingFrom(
        profiles,
        params[LOCAL_PROFILE_UNLOCK_PARAM],
        params[LOCAL_PROFILE_PIN_ERROR_PARAM],
      )}
    />
  );
}
