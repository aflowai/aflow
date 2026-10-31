/**
 * There is nobody to sign in as.
 *
 * Reaching this instance is the whole of the identity, so a 401 never sends an
 * operator to a login page that does not exist.
 *
 * Two 401s mean the browser's profile session is missing or has ended (Plan 335
 * P1). Those send the browser to the front door, which asks who is using Aflow
 * (P3). Every other 401 means the credential this process holds is wrong.
 * Recovery says so, and the notice offers no retry, because asking again would
 * only re-derive the same sentence.
 */
import type { RecoveryAction, SessionRecovery } from '@aflow/web-product';

/** The codes the API's local authentication refuses a profile session with. */
const PROFILE_SESSION_REFUSALS: ReadonlySet<string> = new Set([
  'PROFILE_SESSION_REQUIRED',
  'PROFILE_SESSION_INVALID',
]);

/** Whether a refusal asks the browser to choose a profile. */
export function isProfileSessionRefusal(code: string | null): boolean {
  return code !== null && PROFILE_SESSION_REFUSALS.has(code);
}

/** The front door, which shows the picker to a browser that must choose. */
export const PROFILE_PICKER_ENTRY = '/';

export const INSTANCE_SECRET_MESSAGE =
  'This instance could not authenticate to its own API. Check that the web process and the API share an instance secret.';

export const localRecovery: SessionRecovery = {
  resolve: (_returnTo, code): RecoveryAction =>
    isProfileSessionRefusal(code)
      ? { kind: 'redirect', href: PROFILE_PICKER_ENTRY }
      : { kind: 'message', message: INSTANCE_SECRET_MESSAGE },
};
