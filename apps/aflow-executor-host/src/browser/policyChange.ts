/**
 * What an edit to the machine's policy does to browsers already running.
 *
 * A profile gone from the policy has its browser stopped, and the pages in it
 * go with it. A profile still there takes its new rules at once, and the
 * pages of runs in spaces it no longer serves are closed. Neither waits for
 * the idle limit: until then such a page would go on serving a run that may
 * no longer use the profile, under rules the operator has since removed.
 */
import type { BrowserProfile } from '@aflow/schemas';

import type { PageTable } from './pageTable.js';
import { profileOpenToSpace } from './profiles.js';

export interface PolicyChangeTarget {
  readonly pages: PageTable;
  /** Running browsers by profile; the profile held here is the one its proxy reads. */
  readonly running: ReadonlyMap<string, { readonly state: { profile: BrowserProfile } }>;
  /** The idle sweep's stop. */
  stop(profileId: string): void;
}

export async function applyPolicyChange(
  target: PolicyChangeTarget,
  browsers: ReadonlyMap<string, BrowserProfile>,
): Promise<void> {
  const closing: Array<Promise<void>> = [];
  for (const [profileId, running] of [...target.running]) {
    const profile = browsers.get(profileId);
    const revoked = target.pages
      .all()
      .filter(
        (held) =>
          held.profileId === profileId &&
          (profile === undefined || !profileOpenToSpace(profile, held.spaceId)),
      );
    // Forgotten before anything is awaited, so no operation reaches them meanwhile.
    for (const held of revoked) target.pages.forget(held);
    if (profile === undefined) {
      target.stop(profileId);
      continue;
    }
    running.state.profile = profile;
    closing.push(...revoked.map(async (held) => await held.page.close().catch(() => undefined)));
  }
  await Promise.all(closing);
}
