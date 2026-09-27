/**
 * JIT-provisioning admission decision. An invite always admits at the role it
 * carries; without one, production tenants admit only under an 'open' signup
 * policy (at 'member'). Outside production, or with no default tenant
 * configured, uninvited logins stay admitted — dev parity.
 */
import type { TenantSignupPolicy } from '@aflow/schemas';

export interface JitAdmissionInput {
  isProduction: boolean;
  hasDefaultTenant: boolean;
  invited: boolean;
  inviteRole: string | undefined;
  signupPolicy: TenantSignupPolicy;
}

export type JitAdmission = { admitted: false } | { admitted: true; tenantRole: string };

export function decideJitAdmission(input: JitAdmissionInput): JitAdmission {
  if (input.invited) {
    return { admitted: true, tenantRole: input.inviteRole ?? 'member' };
  }
  if (input.isProduction && input.hasDefaultTenant && input.signupPolicy !== 'open') {
    return { admitted: false };
  }
  return { admitted: true, tenantRole: 'member' };
}
