import { redirect } from 'next/navigation';
import { showsLocalProfilePicker } from '@aflow/web-product';
import { ProfilePicker } from '@aflow/web-product/ui';

import {
  CHOICE_FAILED_MESSAGE,
  CHOICE_FAILED_PARAM,
  readProfileChoices,
} from '@/compose/localProfileSession';

export const dynamic = 'force-dynamic';

/**
 * Switch profile: the picker, opened from the footer menu (Plan 335 D2).
 *
 * An install with one profile has nothing to switch to, so this page sends it
 * to the front door.
 */
export default async function SwitchProfile({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profiles = await readProfileChoices();
  if (profiles === null || !showsLocalProfilePicker(profiles)) redirect('/');
  const failed = (await searchParams)[CHOICE_FAILED_PARAM] !== undefined;
  return (
    <ProfilePicker
      profiles={profiles}
      notice={failed ? CHOICE_FAILED_MESSAGE : null}
      backHref="/"
    />
  );
}
