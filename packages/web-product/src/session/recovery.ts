/**
 * What to do when the API says this caller is not authenticated.
 *
 * The application decides what recovery *means* and this package carries it out.
 * A hosted deployment has somewhere to send the visitor; a local instance does
 * not — a 401 there means the credential this process holds is wrong, and sending
 * the operator to a login page they do not have is worse than telling them.
 *
 * Returning an action rather than performing one is deliberate: the coordination
 * below has to inspect the decision *before* it records an attempt, and a
 * contract that navigates has already committed by the time it reports.
 */
export type RecoveryAction =
  { kind: 'redirect'; href: string } | { kind: 'message'; message: string };

export interface SessionRecovery {
  /**
   * @param returnTo Where the visitor was, as a path with its query and fragment.
   *   Not just the pathname: dropping the query loses the state the page was in,
   *   which for a deep link is the whole address.
   */
  resolve(returnTo: string): RecoveryAction;
}

/** Why authenticated traffic is currently blocked, for a surface to render. */
export interface BlockedSession {
  message: string;
  /**
   * Whether asking to try again would do anything.
   *
   * Not the same as "automatic recovery gave up". An edition with nowhere to send
   * the visitor gives up immediately and a retry only re-derives the same
   * sentence, while an attempt withheld for want of a marker is exactly the case
   * a person asking can settle. A surface that offered a control on the first
   * reading would render a button that does nothing in the local edition.
   */
  canRetry: boolean;
}

/**
 * Whether a response proves this caller's credential was accepted.
 *
 * Two tests are wrong in opposite directions. Waiting for a 2xx is too narrow: a
 * signed-in user who has not yet been admitted is answered `503 NotAdmitted` on
 * every call, so their marker would never clear and every later expiry would
 * report itself exhausted for the life of the tab. Accepting anything that is
 * not a 401 is too broad: the proxy answers for itself when it cannot obtain an
 * upstream credential, and that response never reached the API — reading it as
 * proof lets the next expiry spend a fresh automatic redirect and rebuilds the
 * loop the marker exists to stop.
 *
 * So the question is not what the status was but who answered. A response the
 * proxy generated proves nothing either way; one that came back from the API
 * proves the credential got there, whatever it then said about it.
 */
export function provesAuthenticated(status: number, answeredByProxy: boolean): boolean {
  if (answeredByProxy) return false;
  return status !== 401;
}

/** Where the attempt marker lives, so one tab's loop cannot silence another. */
export const RECOVERY_MARKER = 'phoenix.session.recovery-attempted';

export interface RecoveryHost {
  /** The current location, as a path with query and fragment. */
  currentLocation(): string;
  /** Navigate. Nothing after this runs. */
  navigate(href: string): void;
  /** Per-tab storage, or `null` where it is unavailable. */
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/**
 * One automatic recovery attempt, and an explicit one after that.
 *
 * A cooldown cannot bound this. A login round trip slower than the window
 * restarts the cycle, and the page reloads until the tab is closed — so the rule
 * is one automatic attempt per tab until authenticated traffic is seen again or
 * the visitor asks for another, rather than one attempt per interval.
 *
 * The attempt is recorded *before* navigating, because navigation destroys this
 * component and anything written after it may never run.
 */
export function createSessionRecovery(recovery: SessionRecovery, host: RecoveryHost) {
  // Synchronous, because several requests can fail in the same tick and React state
  // updates are not visible to the others until the next render — which is how
  // concurrent failures become concurrent redirects.
  let inFlight = false;

  /**
   * How many times authentication has failed in this provider's lifetime.
   *
   * A request carries the generation it started under, so a response that was
   * already in flight when the session expired cannot clear the failure that
   * arrived after it. React state cannot serve this: the provider is destroyed by
   * the login redirect, so after the round trip it starts blocked-free while the
   * attempt marker persists — and a success gated on that state would never clear
   * the marker, leaving every later expiry permanently exhausted.
   */
  let generation = 0;

  function attempt(manual: boolean): BlockedSession {
    const action = recovery.resolve(host.currentLocation());

    if (action.kind === 'message') {
      return { message: action.message, canRetry: false };
    }

    const store = host.storage();
    // No storage is not permission to assume a loop cannot happen, so an automatic
    // attempt is offered rather than taken. A visitor who asks is answered: they
    // are the thing a marker would otherwise have to stand in for.
    if (store === null) {
      if (!manual) {
        return { message: 'Your session needs renewing.', canRetry: true };
      }
      host.navigate(action.href);
      return { message: 'Renewing your session…', canRetry: false };
    }

    if (!manual && store.getItem(RECOVERY_MARKER) !== null) {
      return { message: 'Signing in again did not restore this session.', canRetry: true };
    }

    if (!manual && inFlight) return { message: 'Renewing your session…', canRetry: false };
    inFlight = true;
    // Recorded before navigating: navigation destroys this component, and anything
    // written afterwards may never run.
    store.setItem(RECOVERY_MARKER, '1');
    host.navigate(action.href);
    return { message: 'Renewing your session…', canRetry: false };
  }

  return {
    /** The generation a request should carry, read when it starts. */
    generation(): number {
      return generation;
    },

    /** Called for every 401. Returns what a surface should show. */
    onUnauthenticated(): BlockedSession {
      generation += 1;
      return attempt(false);
    },

    /**
     * Authenticated traffic was seen again, on a request that started no earlier
     * than the newest failure.
     *
     * Not gated on anything the provider remembers, because the provider does not
     * survive the redirect: the first accepted success after it has to clear the
     * marker, or recovery is spent for the rest of the tab's life.
     *
     * @returns whether this success was accepted as evidence.
     */
    onAuthenticated(startedAt: number): boolean {
      if (startedAt < generation) return false;
      inFlight = false;
      host.storage()?.removeItem(RECOVERY_MARKER);
      return true;
    },

    /**
     * The visitor asked to try again.
     *
     * Spends an attempt whatever the marker says, and whether or not storage is
     * available — the request is itself the evidence that a loop is not running
     * unattended.
     */
    retry(): BlockedSession {
      host.storage()?.removeItem(RECOVERY_MARKER);
      inFlight = false;
      return attempt(true);
    },
  };
}
