import { describe, expect, it } from 'vitest';
import { decideJitAdmission } from './signupAdmission.js';

const PROD = { isProduction: true, hasDefaultTenant: true };

describe('decideJitAdmission', () => {
  it('open policy admits an uninvited production signup at member', () => {
    expect(
      decideJitAdmission({
        ...PROD,
        invited: false,
        inviteRole: undefined,
        signupPolicy: 'open',
      }),
    ).toEqual({ admitted: true, tenantRole: 'member' });
  });

  it('invite_only rejects an uninvited production signup', () => {
    expect(
      decideJitAdmission({
        ...PROD,
        invited: false,
        inviteRole: undefined,
        signupPolicy: 'invite_only',
      }),
    ).toEqual({ admitted: false });
  });

  it('an invite still elevates the role, regardless of policy', () => {
    for (const signupPolicy of ['invite_only', 'open'] as const) {
      expect(
        decideJitAdmission({ ...PROD, invited: true, inviteRole: 'admin', signupPolicy }),
      ).toEqual({ admitted: true, tenantRole: 'admin' });
    }
  });

  it('an invite without an explicit role admits at member', () => {
    expect(
      decideJitAdmission({ ...PROD, invited: true, inviteRole: undefined, signupPolicy: 'open' }),
    ).toEqual({ admitted: true, tenantRole: 'member' });
  });

  it('outside production, uninvited logins stay admitted under invite_only (dev parity)', () => {
    expect(
      decideJitAdmission({
        isProduction: false,
        hasDefaultTenant: true,
        invited: false,
        inviteRole: undefined,
        signupPolicy: 'invite_only',
      }),
    ).toEqual({ admitted: true, tenantRole: 'member' });
  });

  it('with no default tenant configured, uninvited logins stay admitted', () => {
    expect(
      decideJitAdmission({
        isProduction: true,
        hasDefaultTenant: false,
        invited: false,
        inviteRole: undefined,
        signupPolicy: 'invite_only',
      }),
    ).toEqual({ admitted: true, tenantRole: 'member' });
  });
});
