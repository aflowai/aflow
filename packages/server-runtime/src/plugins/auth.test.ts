/**
 * The development arms of the authentication path: the tokenless bypass and
 * the symmetric secret core verifies with when no distribution supplied a
 * provider.
 *
 * Neither may be reachable where a real directory is in front of the
 * deployment, and both failures are silent — an open bypass looks exactly like
 * a successful login by the time the request reaches a route.
 */
import { describe, expect, it } from 'vitest';

import { ENTERPRISE_IDENTITY_ENV_KEYS } from '@aflow/schemas';

import {
  PRODUCTION_ENV,
  REJECTED,
  VERIFIED,
  buildServer,
  claims,
  get,
  installAuthTestLifecycle,
  mintHs256,
} from './__tests__/authHarness.js';

installAuthTestLifecycle(ENTERPRISE_IDENTITY_ENV_KEYS);

describe('development auth bypass', () => {
  it('answers an unauthenticated request as the dev user in development', async () => {
    const app = await buildServer({});
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authMethod: 'dev_bypass' });
  });

  // The bypass mints an administrator out of a missing header, so the
  // conditions that hold it shut are tested separately — any one of them
  // alone failing open is the whole vulnerability.
  // A core build composes no reader for these, so it does not start at all
  // rather than degrading to a development secret — which would both wave
  // tokenless requests through and verify forged ones. Driven from the
  // descriptor's own list, so a key added there is covered here rather than
  // quietly leaving a way in.
  it.each(ENTERPRISE_IDENTITY_ENV_KEYS)(
    'is unreachable where %s is present, because the process refuses to boot',
    async (key) => {
      await expect(buildServer({ [key]: 'configured' })).rejects.toThrow(
        /this build composes no provider/i,
      );
    },
  );

  // Both production combinations are unreachable rather than merely shut: a
  // build that composes no identity provider has nothing but the development
  // secret to verify a real token with, so it refuses to start rather than
  // leaving the bypass as the last thing standing between the two.
  it('cannot be reached in production, with or without identity configuration', async () => {
    for (const env of [
      PRODUCTION_ENV,
      {
        ...PRODUCTION_ENV,
        ...Object.fromEntries(ENTERPRISE_IDENTITY_ENV_KEYS.map((k) => [k, 'x'])),
      },
    ]) {
      await expect(buildServer(env)).rejects.toThrow(
        /production security configuration is incomplete/i,
      );
    }
  });
});

describe('development token secret', () => {
  it('verifies a token minted against the configured JWT_SECRET, and no other', async () => {
    const app = await buildServer({ JWT_SECRET: 'configured-dev-secret' });
    expect((await get(app, mintHs256(claims(), 'configured-dev-secret'))).statusCode).toBe(
      VERIFIED,
    );
    expect((await get(app, mintHs256(claims(), 'some-other-secret'))).statusCode).toBe(REJECTED);
  });

  // An unset JWT_SECRET draws a fresh random value per process, so a token is
  // only ever valid at the one instance that issued it. A shipped constant
  // would make every deployment that forgot to set the variable interchangeable
  // with an attacker's copy of this repository — which is the whole reason the
  // fallback is random, and the only way to observe it is to check that two
  // instances do not honour each other's tokens.
  it('draws an unconfigured secret per process rather than from a shipped constant', async () => {
    const first = await buildServer({});
    const second = await buildServer({});
    const token = first.jwt.sign({ sub: 'auth0|subject' });

    expect((await get(first, token)).statusCode).toBe(VERIFIED);
    expect((await get(second, token)).statusCode).toBe(REJECTED);
  });
});
