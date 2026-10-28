/**
 * Contract (Plan 320 D20): the read a skill's browser rule makes is stamped
 * with whether the run's grant covers a harness browser, judged as the gate on
 * a harness run would judge it — so the rule runs without a browser where the
 * grant withholds one, rather than the run being refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAccessGrant, TenantId } from '@aflow/schemas';

const established = vi.hoisted(() => ({ value: { kind: 'ungoverned' } as unknown }));

vi.mock('../../../SessionOrchestrator/helpers/workflowGrantGate.js', () => ({
  establishRunAccessGrant: vi.fn(async () => await Promise.resolve(established.value)),
}));

import { establishRunAccessGrant } from '../../../SessionOrchestrator/helpers/workflowGrantGate.js';
import { browserGrantFor } from '../browserGrant.js';

function grant(pages: boolean): RunAccessGrant {
  return {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [
        { capabilityGroupId: 'host.harness', accessMode: 'write' },
        { capabilityGroupId: 'host.binding', accessMode: 'read' },
        ...(pages ? [{ capabilityGroupId: 'browser.page', accessMode: 'write' as const }] : []),
      ],
      deniedCapabilities: [],
      // Opening a page acts outside the platform, which a grant has to allow as well.
      allowedRiskModifiers: pages ? ['external_side_effect'] : [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

const deps = { db: {} as never, redis: {} as never };
const tenant = 't' as TenantId;

describe('the browser grant a folder read carries', () => {
  beforeEach(() => {
    established.value = { kind: 'ungoverned' };
  });

  it('is judged for host.binding.inspect from the run’s grant', async () => {
    established.value = { kind: 'granted', grant: grant(true) };
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBe(true);
    established.value = { kind: 'granted', grant: grant(false) };
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBe(false);
  });

  it('is withheld where the run’s authority is revoked or unknown', async () => {
    established.value = { kind: 'authority_revoked', detail: 'gone' };
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBe(false);
    established.value = { kind: 'authority_unavailable', detail: 'down' };
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBe(false);
  });

  it('withholds the browser, never the read, where the grant cannot be read at all', async () => {
    vi.mocked(establishRunAccessGrant).mockRejectedValueOnce(new Error('redis down'));
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBe(false);
  });

  it('is not judged for a run started with no authority, any other operation, or no anchor', async () => {
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.binding.inspect')).toBeUndefined();
    established.value = { kind: 'granted', grant: grant(false) };
    expect(await browserGrantFor(deps, tenant, 'anchor', 'host.harness.run')).toBeUndefined();
    expect(await browserGrantFor(deps, tenant, undefined, 'host.binding.inspect')).toBeUndefined();
  });
});
