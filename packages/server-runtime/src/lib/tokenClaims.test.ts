/**
 * The claim reader exists because an Auth0 access token carries profile
 * claims only under a namespace. Reading `email_verified` bare answered
 * `undefined` for every real login, which the trust checks then took for
 * "the IdP says no" — every account provisioned without an address, and no
 * error anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readBooleanClaim, readClaim, readStringClaim } from './tokenClaims.js';

const NS = 'https://aflow.ai/';

describe('readClaim', () => {
  it('reads the namespaced form an action injects', () => {
    expect(readClaim({ [`${NS}email`]: 'a@b.co' }, 'email')).toBe('a@b.co');
  });

  it('falls back to a bare claim when no namespaced one exists', () => {
    expect(readClaim({ email: 'a@b.co' }, 'email')).toBe('a@b.co');
  });

  it('does not mistake a longer namespaced claim for a shorter one', () => {
    const claims = { [`${NS}email_verified`]: true };
    expect(readClaim(claims, 'email')).toBeUndefined();
  });

  it('is undefined for a claim the token does not carry', () => {
    expect(readClaim({ sub: 'auth0|1' }, 'email_verified')).toBeUndefined();
  });
});

describe('readStringClaim', () => {
  it('rejects a non-string and an empty value', () => {
    expect(readStringClaim({ [`${NS}name`]: 42 }, 'name')).toBeUndefined();
    expect(readStringClaim({ [`${NS}name`]: '  ' }, 'name')).toBeUndefined();
  });
});

describe('readBooleanClaim', () => {
  it('reads a namespaced boolean', () => {
    expect(readBooleanClaim({ [`${NS}email_verified`]: true }, 'email_verified')).toBe(true);
    expect(readBooleanClaim({ [`${NS}email_verified`]: false }, 'email_verified')).toBe(false);
  });

  it('accepts the stringified forms an action may emit', () => {
    expect(readBooleanClaim({ [`${NS}email_verified`]: 'true' }, 'email_verified')).toBe(true);
    expect(readBooleanClaim({ [`${NS}email_verified`]: 'false' }, 'email_verified')).toBe(false);
  });

  it('separates an absent claim from a false one', () => {
    expect(readBooleanClaim({ email: 'a@b.co' }, 'email_verified')).toBeUndefined();
    expect(readBooleanClaim({ email_verified: false }, 'email_verified')).toBe(false);
  });
});
