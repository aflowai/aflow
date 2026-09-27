import { describe, expect, it } from 'vitest';
import type { EditionDescriptor } from './descriptor.js';
import { defaultsToSafeProfile } from './spaceCapabilityDefault.js';

const hosted: EditionDescriptor = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
  computeRuntime: 'present',
  codeLane: 'present',
  hostLane: 'absent',
};

const appliance: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: '00000000-0000-4000-8000-0000000ed1c0' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
};

describe('defaultsToSafeProfile', () => {
  it('holds a member to the safe ceiling', () => {
    expect(defaultsToSafeProfile({ isTenantAdmin: false, edition: hosted })).toBe(true);
  });

  it('lets a tenant admin provision an unrestricted space', () => {
    expect(defaultsToSafeProfile({ isTenantAdmin: true, edition: hosted })).toBe(false);
  });

  // Both flag values: one creation path infers admin-ness from a membership
  // lookup that can miss, and the answer here must not depend on it.
  it('starts every space on a fixed-tenancy instance unrestricted', () => {
    expect(defaultsToSafeProfile({ isTenantAdmin: true, edition: appliance })).toBe(false);
    expect(defaultsToSafeProfile({ isTenantAdmin: false, edition: appliance })).toBe(false);
  });
});
