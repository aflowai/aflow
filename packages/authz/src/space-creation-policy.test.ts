/**
 * Creation-gate policy: every space starts solo, so creation is a plain
 * tenant-role check — member and above. Sharing authority is a separate
 * concern enforced at the share/membership surface, not at creation.
 */
import { describe, expect, it } from 'vitest';
import { canCreateSpace } from './rbac.js';
import type { TenantRole } from './types.js';

const CASES: Array<{ tenantRole: TenantRole; allowed: boolean }> = [
  { tenantRole: 'owner', allowed: true },
  { tenantRole: 'admin', allowed: true },
  { tenantRole: 'member', allowed: true },
  { tenantRole: 'viewer', allowed: false },
  { tenantRole: 'billing', allowed: false },
];

describe('canCreateSpace', () => {
  it.each(CASES)('$tenantRole → $allowed', ({ tenantRole, allowed }) => {
    expect(canCreateSpace(tenantRole)).toBe(allowed);
  });
});
