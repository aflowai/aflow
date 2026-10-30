/**
 * The local identity's four outcomes, which are four different answers the
 * caller owes. A boolean here would have collapsed the two that matter most:
 * a request refused for arriving under someone else's name, and a process that
 * has no credential to attach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INSTANCE_SECRET_ENV,
  PROFILE_SESSION_COOKIE,
  localWebComposition,
  localWebIdentity,
} from './localWebIdentity.js';

const SECRET = 'a'.repeat(40);

const browserCookies = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = browserCookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

beforeEach(() => {
  browserCookies.clear();
});

function request(headers: Record<string, string>, url = 'http://127.0.0.1:3002/api/identity') {
  return new Request(url, { headers });
}

function withSecret<T>(value: string | undefined, run: () => T): T {
  const before = process.env[INSTANCE_SECRET_ENV];
  if (value === undefined) delete process.env[INSTANCE_SECRET_ENV];
  else process.env[INSTANCE_SECRET_ENV] = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env[INSTANCE_SECRET_ENV];
    else process.env[INSTANCE_SECRET_ENV] = before;
  }
}

describe('admitRequest', () => {
  it('authorizes a loopback request once the instance has a credential', async () => {
    const decision = await withSecret(SECRET, () =>
      localWebIdentity.admitRequest(request({ host: '127.0.0.1:3002' })),
    );
    expect(decision).toEqual({ kind: 'authorized' });
  });

  it('refuses a routable host rather than attaching the owner credential to it', async () => {
    const decision = await withSecret(SECRET, () =>
      localWebIdentity.admitRequest(
        request({ host: 'appliance.lan' }, 'http://appliance.lan/api/identity'),
      ),
    );
    expect(decision.kind).toBe('refused');
  });

  it('separates a missing credential from a refusal', async () => {
    // Both deny the request and they are not the same problem: one is the
    // operator's configuration and the other is the caller's address.
    const decision = await withSecret(undefined, () =>
      localWebIdentity.admitRequest(request({ host: '127.0.0.1:3002' })),
    );
    expect(decision.kind).toBe('unavailable');
  });
});

describe('authorizeUpstream', () => {
  // The mark is what the API reads to refuse a browser that has lost its
  // profile session once the install has a second profile. A call without it
  // would pass as a bare-secret caller and act as the owner.
  it('carries the instance secret and marks the call as a browser', async () => {
    const outcome = await withSecret(SECRET, () =>
      localWebIdentity.authorizeUpstream({ anonymousOk: false }),
    );
    expect(outcome).toEqual({
      kind: 'authorized',
      header: `Bearer ${SECRET}`,
      headers: { 'x-aflow-browser-caller': '1' },
    });
  });

  it('forwards the profile session the browser holds', async () => {
    browserCookies.set(PROFILE_SESSION_COOKIE, 'v1.session');
    const outcome = await withSecret(SECRET, () =>
      localWebIdentity.authorizeUpstream({ anonymousOk: false }),
    );
    expect(outcome.kind === 'authorized' && outcome.headers).toEqual({
      'x-aflow-browser-caller': '1',
      'x-aflow-profile-session': 'v1.session',
    });
  });

  it('is unavailable rather than anonymous when no secret is set', async () => {
    // There is no anonymous mode to fall back to. Answering `anonymous` would
    // reach the API with no credential and 401 every call with nothing naming
    // the cause, which is the failure this outcome exists to prevent.
    for (const anonymousOk of [true, false]) {
      const outcome = await withSecret(undefined, () =>
        localWebIdentity.authorizeUpstream({ anonymousOk }),
      );
      expect(outcome.kind).toBe('unavailable');
    }
  });
});

describe('the composition', () => {
  it('states the front door instead of inferring it from configuration', () => {
    expect(localWebComposition.entry).toBe('product');
  });

  it('reports a missing instance secret as a configuration violation', () => {
    expect(localWebIdentity.configurationViolations({}).map((v) => v.key)).toEqual([
      INSTANCE_SECRET_ENV,
    ]);
    expect(localWebIdentity.configurationViolations({ [INSTANCE_SECRET_ENV]: SECRET })).toEqual([]);
  });
});
