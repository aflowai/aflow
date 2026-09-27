/**
 * A member has to be able to boot the app: who they are, which tenant they
 * are in, and whether they still owe an agreement. Denying that does not
 * degrade the product for a non-admin — it stops it from starting, and the
 * failure reads as "you have no spaces" rather than as a permission problem.
 * It also strands the Terms gate, whose own discovery endpoint is one of
 * those reads, so the prompt that would clear the block never appears.
 *
 * Those needs are met by `tenant_self`, deliberately not by `tenant/read` —
 * that resource also covers governance: the integration host allowlist, who
 * requested what, egress approvals. A grant wide enough to boot the shell
 * would have carried all of it to every member of the tenant.
 */
import { describe, expect, it } from 'vitest';
import { checkMemberUnscopedAccess, checkTenantRbac } from './rbac.js';

describe('a member booting the app', () => {
  it('can read their own shell state', () => {
    expect(checkMemberUnscopedAccess('tenant_self', 'read')).toBe(true);
  });

  it('still cannot read the tenant surface that governance shares', () => {
    expect(checkMemberUnscopedAccess('tenant', 'read')).toBe(false);
    expect(checkTenantRbac('member', 'tenant', 'read')).toBe(false);
  });

  it('cannot write or administer through the narrow resource', () => {
    expect(checkMemberUnscopedAccess('tenant_self', 'write')).toBe(false);
    expect(checkMemberUnscopedAccess('tenant_self', 'admin')).toBe(false);
    expect(checkTenantRbac('member', 'tenant', 'owner_admin')).toBe(false);
  });

  it('keeps its existing self-service write', () => {
    // Editing your own profile was already allowed and is unchanged.
    expect(checkTenantRbac('member', 'tenant', 'write')).toBe(true);
  });

  it('gains nothing else — secrets and space content are untouched', () => {
    expect(checkMemberUnscopedAccess('secret', 'read')).toBe(false);
    expect(checkTenantRbac('member', 'secret', 'read')).toBe(false);
  });

  it('does not widen admin-only roles downward', () => {
    // Higher roles reach `tenant_self` through their own read grant, so the
    // narrow resource adds nothing for them and removes nothing either.
    expect(checkTenantRbac('viewer', 'tenant_self', 'read')).toBe(true);
    expect(checkTenantRbac('billing', 'tenant_self', 'read')).toBe(false);
  });
});
