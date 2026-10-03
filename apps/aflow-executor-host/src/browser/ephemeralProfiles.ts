/**
 * The throwaway profiles harness runs browse with (Plan 320 D6, D12).
 *
 * One per run that asked for it: a fresh directory made for the run and
 * deleted with it, no sign-ins, its own Chrome. It belongs to the run that
 * asked for it — any other run is answered as if it did not exist — and it is
 * the one profile whose proxy lets it reach this machine, because it carries
 * no session an agent could act with there.
 */
import { randomBytes } from 'node:crypto';

import {
  type BrowserProfile,
  BrowserProfileSchema,
  EPHEMERAL_BROWSER_PROFILE,
  isEphemeralBrowserProfileId,
} from '@aflow/schemas';

import { BrowserDriverError } from './errors.js';
import type { PageOwner } from './pageTable.js';

interface HeldEphemeral {
  readonly profile: BrowserProfile;
  readonly owner: PageOwner;
  readonly userDataDir: string;
}

export class EphemeralProfiles {
  private readonly held = new Map<string, HeldEphemeral>();

  add(owner: PageOwner, userDataDir: string): BrowserProfile {
    const id = `${EPHEMERAL_BROWSER_PROFILE}-${randomBytes(6).toString('hex')}`;
    const profile: BrowserProfile = { ...BrowserProfileSchema.omit({ id: true }).parse({}), id };
    this.held.set(id, {
      profile,
      owner: { tenantId: owner.tenantId, runId: owner.runId },
      userDataDir,
    });
    return profile;
  }

  remove(profileId: string): void {
    this.held.delete(profileId);
  }

  has(profileId: string): boolean {
    return this.held.has(profileId);
  }

  directory(profileId: string): string | undefined {
    return this.held.get(profileId)?.userDataDir;
  }

  all(): BrowserProfile[] {
    return [...this.held.values()].map((held) => held.profile);
  }

  /**
   * The ephemeral profile a run may use, or nothing when the id names no
   * ephemeral profile at all and the machine's policy is the one to ask.
   */
  resolve(profileId: string, scope: PageOwner): BrowserProfile | undefined {
    if (!isEphemeralBrowserProfileId(profileId)) return undefined;
    const held = this.held.get(profileId);
    const owned = held?.owner.tenantId === scope.tenantId && held.owner.runId === scope.runId;
    if (held === undefined || !owned) {
      throw new BrowserDriverError(
        'unknown_profile',
        `This run has no browser profile \`${profileId}\`. An ephemeral profile belongs to the ` +
          'harness run that asked for it and ends with that run.',
      );
    }
    return held.profile;
  }
}
