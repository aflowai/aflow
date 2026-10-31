import { enterPreferredSpace, type SpaceLookupRefusal } from '@aflow/web-product/ui/server';
import { ProfilePicker } from '@aflow/web-product/ui';

import { localWebIdentity } from '@/compose/localWebIdentity';
import { readProfileChoices, requiresProfileChoice } from '@/compose/localProfileSession';

/** Shown in place of the tiles when the API could not list the profiles. */
const PROFILES_UNREAD = 'The profiles could not be read. Reload the page to try again.';

/**
 * Who is using Aflow? (Plan 335 D1). The API refuses a browser with no profile
 * session once the install has a second profile, and the picker answers that
 * refusal. An install with one profile is never refused, so it never sees one.
 */
async function profilePicker(refusal: SpaceLookupRefusal) {
  if (!requiresProfileChoice(refusal)) return null;
  const profiles = await readProfileChoices();
  return profiles === null ? (
    <ProfilePicker profiles={[]} notice={PROFILES_UNREAD} />
  ) : (
    <ProfilePicker profiles={profiles} />
  );
}

/**
 * The front door.
 *
 * The composition states `entry: 'product'`, and the product's own entry is the
 * conversation — which this build carries, under a space. A front door has no
 * space of its own, so it enters the one this visitor last used, and asks the API
 * which spaces they can reach so a stale hint does not send them to a 404.
 */
export default async function Home() {
  return enterPreferredSpace('/chat', {
    apiUrl: process.env.API_URL || 'http://localhost:3000',
    headers: async (): Promise<Record<string, string> | null> => {
      const authorization = await localWebIdentity.authorizeUpstream({ anonymousOk: false });
      return authorization.kind === 'authorized'
        ? { ...authorization.headers, Authorization: authorization.header }
        : null;
    },
    answerRefusal: profilePicker,
  });
}
