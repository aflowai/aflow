/**
 * What an edit to the machine's policy does to browsers already running or
 * still starting.
 *
 * A profile gone from the policy has its browser stopped, and the pages in it
 * go with it; one still starting is stopped as soon as it has started. A
 * profile still there takes its new rules at once, and the pages of runs it
 * no longer serves — another space, or a run nobody is present for once it
 * takes none — are closed. Neither waits for the idle limit:
 * until then such a page would go on serving a run that may no longer use the
 * profile, under rules the operator has since removed.
 */
import type { BrowserProfile } from '@aflow/schemas';

import { closeWithinDeadline, type PageTable } from './pageTable.js';
import { profileServesRun } from './profiles.js';

export interface PolicyChangeTarget {
  readonly pages: PageTable;
  /**
   * Browsers running or still starting, by profile. The profile held here is
   * the one its proxy reads, and this change is the only thing that rewrites it.
   */
  readonly browsers: ReadonlyMap<string, { readonly state: { profile: BrowserProfile } }>;
  /** Stops a running browser; one still starting stops as soon as it has started. */
  stop(profileId: string): void;
}

export async function applyPolicyChange(
  target: PolicyChangeTarget,
  browsers: ReadonlyMap<string, BrowserProfile>,
): Promise<void> {
  const closing: Array<Promise<void>> = [];
  for (const [profileId, browser] of [...target.browsers]) {
    const profile = browsers.get(profileId);
    const revoked = target.pages
      .all()
      .filter(
        (held) =>
          held.profileId === profileId &&
          (profile === undefined || !profileServesRun(profile, held)),
      );
    // Forgotten before anything is awaited, so no operation reaches them meanwhile.
    for (const held of revoked) target.pages.forget(held);
    if (profile === undefined) {
      target.stop(profileId);
      continue;
    }
    browser.state.profile = profile;
    closing.push(...revoked.map((held) => closeWithinDeadline(held.page)));
  }
  await Promise.all(closing);
}
