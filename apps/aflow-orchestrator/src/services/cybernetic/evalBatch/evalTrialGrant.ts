/**
 * The eval trial grant (Plan 269 D5) — the salvaged Plan 71 read-only
 * grant, minted by the trusted launcher and never compiled from a space
 * profile. `live` trials execute in the HOME space, so their grant is
 * `accessLevel: 'read'`: every mutating operation is denied at step gating
 * with a non-retryable permission error (a gradable observation), while
 * real reads — including external reads like search — still work. `seeded`
 * `seeded` and `sealed` trials execute in their own fixture space, which IS
 * the isolation boundary, so in-space writes stay allowed there — and a sealed
 * trial's external calls reach a simulation rather than a service, so the
 * writes it is measured on cost nothing outside the fixture.
 *
 * The grant is stored under the trial's anchor session and inherited
 * verbatim by every Runner the trial spawns. It is deliberately long-lived:
 * grant auto-renewal recompiles from the space's capability assignment,
 * which would silently re-escalate a live trial to the home space's write
 * posture mid-run.
 */
import type { RunAccessGrant } from '@aflow/schemas';
import type { LaunchableFixtureTier } from './frozenRunGate.js';

/** No operator holds this grant — trials run under a system principal. */
const EVAL_GRANT_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export const EVAL_TRIAL_GRANT_LIFETIME_SECONDS = 24 * 60 * 60;

export function buildEvalTrialGrant(params: {
  /** The space the trial RUN executes in (home for live, fixture otherwise). */
  runSpaceId: string;
  fixtureTier: LaunchableFixtureTier;
}): RunAccessGrant {
  const now = new Date();
  return {
    spaceId: params.runSpaceId,
    accessLevel: params.fixtureTier === 'live' ? 'read' : 'write',
    grantedToUserId: EVAL_GRANT_SYSTEM_USER_ID,
    tenantRole: 'system',
    spaceRole: 'viewer',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EVAL_TRIAL_GRANT_LIFETIME_SECONDS * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [],
      deniedCapabilities: [],
      // External reads (search, live API reads) stay real — that is the
      // point of the live tier; mutations are stopped by accessLevel.
      allowedRiskModifiers: ['external_side_effect'],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    compiledProfileName:
      params.fixtureTier === 'live'
        ? 'Eval read-only (frozen trial)'
        : 'Eval fixture (frozen trial)',
    resourceScopes: [],
  };
}
