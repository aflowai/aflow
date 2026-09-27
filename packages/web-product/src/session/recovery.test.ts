/**
 * Recovery from an expired session, per outcome.
 *
 * Two of these are regressions the previous arrangement had. A successful
 * response cleared the attempt marker but never unblocked the session, and
 * because the handler returned early while blocked, no later expiry recovered at
 * all. And a second recovery path redirected without consulting the coordination,
 * so the one attempt it allows could be spent twice.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_MARKER,
  createSessionRecovery,
  provesAuthenticated,
  type SessionRecovery,
} from './recovery.js';

function host(options: { storage?: boolean; at?: string } = {}) {
  const store = new Map<string, string>();
  const navigated: string[] = [];
  return {
    navigated,
    store,
    impl: {
      currentLocation: () => options.at ?? '/chat?tab=runs#step-3',
      navigate: (href: string) => navigated.push(href),
      storage: () =>
        options.storage === false
          ? null
          : {
              getItem: (k: string) => store.get(k) ?? null,
              setItem: (k: string, v: string) => void store.set(k, v),
              removeItem: (k: string) => void store.delete(k),
            },
    },
  };
}

const hosted: SessionRecovery = {
  resolve: (returnTo) => ({
    kind: 'redirect',
    href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  }),
};

const local: SessionRecovery = {
  resolve: () => ({
    kind: 'message',
    message: 'This instance could not authenticate to its own API. Check the instance secret.',
  }),
};

describe('an edition with somewhere to sign in', () => {
  it('redirects once and carries the whole location', () => {
    const h = host();
    const recovery = createSessionRecovery(hosted, h.impl);
    const blocked = recovery.onUnauthenticated();

    expect(h.navigated).toEqual([
      '/auth/login?returnTo=' + encodeURIComponent('/chat?tab=runs#step-3'),
    ]);
    expect(blocked.canRetry).toBe(false);
  });

  it('records the attempt before navigating', () => {
    const h = host();
    const order: string[] = [];
    const impl = {
      ...h.impl,
      navigate: () => order.push('navigate'),
      storage: () => ({
        getItem: () => null,
        setItem: () => order.push('mark'),
        removeItem: () => undefined,
      }),
    };
    createSessionRecovery(hosted, impl).onUnauthenticated();
    // Navigation destroys this component, so anything written after it may not run.
    expect(order).toEqual(['mark', 'navigate']);
  });

  it('turns concurrent failures into one attempt', () => {
    const h = host();
    const recovery = createSessionRecovery(hosted, h.impl);
    recovery.onUnauthenticated();
    recovery.onUnauthenticated();
    recovery.onUnauthenticated();
    expect(h.navigated).toHaveLength(1);
  });

  // A cooldown cannot bound this: a login round trip slower than the window
  // restarts the cycle and the page reloads until the tab closes.
  it('does not try again automatically when signing in did not help', () => {
    const h = host();
    h.store.set(RECOVERY_MARKER, '1');
    const blocked = createSessionRecovery(hosted, h.impl).onUnauthenticated();
    expect(h.navigated).toEqual([]);
    expect(blocked.canRetry).toBe(true);
    expect(blocked.message).toContain('did not restore');
  });

  it('spends a fresh attempt only when the visitor asks', () => {
    const h = host();
    h.store.set(RECOVERY_MARKER, '1');
    const recovery = createSessionRecovery(hosted, h.impl);
    expect(recovery.onUnauthenticated().canRetry).toBe(true);
    expect(h.navigated).toEqual([]);

    recovery.retry();
    expect(h.navigated).toHaveLength(1);
  });

  // The regression: clearing the marker is not the same as unblocking, and the
  // handler returned early while blocked — so nothing recovered afterwards.
  it('recovers again after authenticated traffic returns', () => {
    const h = host();
    const recovery = createSessionRecovery(hosted, h.impl);
    const at = recovery.generation();
    recovery.onUnauthenticated();
    expect(h.navigated).toHaveLength(1);

    expect(recovery.onAuthenticated(recovery.generation())).toBe(true);
    expect(h.store.has(RECOVERY_MARKER)).toBe(false);
    expect(at).toBe(0);

    recovery.onUnauthenticated();
    expect(h.navigated).toHaveLength(2);
  });

  /**
   * The login redirect destroys the provider, so after the round trip nothing it
   * held says a failure happened — only the marker does. A success judged against
   * the provider's own state therefore never clears it, and every later expiry
   * reads the marker and reports itself exhausted for the rest of the tab's life.
   */
  it('clears the attempt on the first success after the redirect remounts it', () => {
    const h = host();
    h.store.set(RECOVERY_MARKER, '1'); // survived the navigation

    const fresh = createSessionRecovery(hosted, h.impl); // a new provider, no failures yet
    expect(fresh.onAuthenticated(fresh.generation())).toBe(true);
    expect(h.store.has(RECOVERY_MARKER)).toBe(false);

    // And recovery works again, rather than being permanently spent.
    fresh.onUnauthenticated();
    expect(h.navigated).toHaveLength(1);
  });

  it('does not let a response from before a failure clear it', () => {
    const h = host();
    const recovery = createSessionRecovery(hosted, h.impl);
    const startedEarlier = recovery.generation(); // a request already in flight
    recovery.onUnauthenticated(); // it expires while that request is outstanding

    expect(recovery.onAuthenticated(startedEarlier)).toBe(false);
    expect(h.store.has(RECOVERY_MARKER)).toBe(true);
  });

  it('lets the visitor retry with no storage, where an automatic attempt is refused', () => {
    const h = host({ storage: false });
    const recovery = createSessionRecovery(hosted, h.impl);
    expect(recovery.onUnauthenticated().canRetry).toBe(true);
    expect(h.navigated).toEqual([]);

    // Asking is the evidence a marker would otherwise stand in for.
    expect(recovery.retry().canRetry).toBe(false);
    expect(h.navigated).toHaveLength(1);
  });

  it('offers the action rather than taking it when there is no storage', () => {
    const h = host({ storage: false });
    const blocked = createSessionRecovery(hosted, h.impl).onUnauthenticated();
    // Without a marker there is nothing to stop a second attempt, so an automatic
    // one cannot be shown to terminate.
    expect(h.navigated).toEqual([]);
    expect(blocked.canRetry).toBe(true);
  });
});

describe('an edition with nobody to sign in as', () => {
  it('never navigates, and says what is actually wrong', () => {
    const h = host();
    const blocked = createSessionRecovery(local, h.impl).onUnauthenticated();
    expect(h.navigated).toEqual([]);
    expect(blocked.canRetry).toBe(false);
    expect(blocked.message).toContain('instance secret');
  });

  it('spends no attempt, so the marker stays untouched', () => {
    const h = host();
    createSessionRecovery(local, h.impl).onUnauthenticated();
    expect(h.store.has(RECOVERY_MARKER)).toBe(false);
  });

  it('offers no retry, because asking again only re-derives the same sentence', () => {
    const h = host();
    const recovery = createSessionRecovery(local, h.impl);
    expect(recovery.onUnauthenticated().canRetry).toBe(false);
    expect(recovery.retry().canRetry).toBe(false);
    expect(h.navigated).toEqual([]);
  });
});

describe('what counts as evidence the credential was accepted', () => {
  it('accepts a plain success', () => {
    expect(provesAuthenticated(200, false)).toBe(true);
  });

  /**
   * The path a 2xx test misses. A signed-in user awaiting admission is answered
   * `503 NotAdmitted` on every call, so waiting for success would never clear
   * their attempt marker and every later expiry would report itself exhausted.
   */
  it('accepts the 503 a signed-in but unadmitted user gets on every call', () => {
    expect(provesAuthenticated(503, false)).toBe(true);
  });

  it('accepts a forbidden or failing response — the credential still got through', () => {
    for (const status of [403, 404, 409, 422, 500]) {
      expect(provesAuthenticated(status, false), `status ${status}`).toBe(true);
    }
  });

  it('refuses only the status that means the credential was not accepted', () => {
    expect(provesAuthenticated(401, false)).toBe(false);
  });
});

describe('a response the proxy answered itself', () => {
  /**
   * The transport answers for itself when it cannot obtain an upstream
   * credential, and that response never reached the API. Reading it as proof
   * clears the attempt marker, which hands the next expiry a fresh automatic
   * redirect — the loop this coordination exists to stop.
   */
  it('proves nothing, whatever status it carries', () => {
    for (const status of [502, 503, 403]) {
      expect(provesAuthenticated(status, true), `proxy ${status}`).toBe(false);
    }
  });

  it('is not confused with the API answering the same status', () => {
    // The API's `NotAdmitted` 503 means the credential did arrive.
    expect(provesAuthenticated(503, false)).toBe(true);
    expect(provesAuthenticated(503, true)).toBe(false);
  });

  it('still refuses a 401 either way', () => {
    expect(provesAuthenticated(401, false)).toBe(false);
    expect(provesAuthenticated(401, true)).toBe(false);
  });
});
