/**
 * There is nobody to sign in as.
 *
 * Reaching this instance is the whole of the identity, so a 401 never sends an
 * operator to a login page that does not exist. Recovery says what is wrong
 * instead, and the notice offers no retry, because asking again would only
 * re-derive the same sentence.
 *
 * Two 401s mean the browser's profile session is missing or has ended (Plan 335
 * P1). Every other 401 means the credential this process holds is wrong.
 */
import type { RecoveryAction, SessionRecovery } from '@aflow/web-product';

/** The codes the API's local authentication refuses a profile session with. */
const PROFILE_SESSION_REFUSALS: ReadonlySet<string> = new Set([
  'PROFILE_SESSION_REQUIRED',
  'PROFILE_SESSION_INVALID',
]);

export const PROFILE_SESSION_MESSAGE =
  'This browser has no profile session, or its profile session has ended. Choose a profile to continue.';

export const INSTANCE_SECRET_MESSAGE =
  'This instance could not authenticate to its own API. Check that the web process and the API share an instance secret.';

export const localRecovery: SessionRecovery = {
  resolve: (_returnTo, code): RecoveryAction => ({
    kind: 'message',
    message:
      code !== null && PROFILE_SESSION_REFUSALS.has(code)
        ? PROFILE_SESSION_MESSAGE
        : INSTANCE_SECRET_MESSAGE,
  }),
};
