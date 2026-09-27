import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityProfileRow } from '@aflow/database';
import type { RunAccessGrant } from '@aflow/schemas';
import {
  applyCapabilityCeiling,
  clearCeilingCache,
  deriveAccessLevel,
  loadEffectiveCeilingExclusions,
  applyUserCapabilityGrants,
} from './policy-compiler.js';

function profile(overrides: Partial<CapabilityProfileRow> = {}): CapabilityProfileRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Test',
    description: null,
    allowedCapabilities: [],
    deniedCapabilities: [],
    gatedCapabilities: [],
    allowedRiskModifiers: [],
    deniedRiskModifiers: [],
    allowPrivileged: false,
    isDefault: false,
    isSystemProfile: false,
    defaultForRole: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CapabilityProfileRow;
}

describe('deriveAccessLevel', () => {
  it('returns "write" when allowedCapabilities contains a write', () => {
    const p = profile({
      allowedCapabilities: [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
    });
    expect(deriveAccessLevel(p)).toBe('write');
  });

  it('returns "read" when only read capabilities are allowed', () => {
    const p = profile({
      allowedCapabilities: [{ capabilityGroupId: 'ai.text', accessMode: 'read' }],
    });
    expect(deriveAccessLevel(p)).toBe('read');
  });

  it('returns "read" when allowedCapabilities is empty', () => {
    expect(deriveAccessLevel(profile())).toBe('read');
  });
});

describe('applyCapabilityCeiling', () => {
  const baseGrant = (): RunAccessGrant =>
    ({
      spaceId: 's1',
      accessLevel: 'write',
      grantedToUserId: 'u1',
      tenantRole: 'member',
      spaceRole: 'admin',
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capabilities: {
        allowedCapabilities: [
          { capabilityGroupId: 'memory.write', accessMode: 'write' },
          { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
          { capabilityGroupId: 'code.agent', accessMode: 'write' },
        ],
        deniedCapabilities: [],
        allowedRiskModifiers: ['external_side_effect'],
        deniedRiskModifiers: [],
        allowPrivileged: false,
      },
      grantReason: 'session_start',
      compiledProfileId: 'p1',
      compilerVersion: '2.1.0',
      resourceScopes: [],
    }) as unknown as RunAccessGrant;

  it('removes excluded groups from the allowlist AND adds them to the denylist', () => {
    const out = applyCapabilityCeiling(baseGrant(), ['compute.sandbox', 'code.agent']);
    const allowedIds = out.capabilities.allowedCapabilities.map((c) => c.capabilityGroupId);
    expect(allowedIds).toEqual(['memory.write']);
    const denied = out.capabilities.deniedCapabilities.map(
      (c) => `${c.capabilityGroupId}:${c.accessMode}`,
    );
    expect(denied).toEqual([
      'compute.sandbox:read',
      'compute.sandbox:write',
      'code.agent:read',
      'code.agent:write',
    ]);
  });

  it('returns the grant unchanged for an empty exclusion list', () => {
    const grant = baseGrant();
    expect(applyCapabilityCeiling(grant, [])).toBe(grant);
  });

  it('denies excluded groups even when the profile never allowed them (deny wins over any future profile)', () => {
    const grant = baseGrant();
    grant.capabilities.allowedCapabilities = [
      { capabilityGroupId: 'memory.write', accessMode: 'write' },
    ];
    const out = applyCapabilityCeiling(grant, ['code.repo']);
    expect(
      out.capabilities.deniedCapabilities.some((c) => c.capabilityGroupId === 'code.repo'),
    ).toBe(true);
  });
});

describe('loadEffectiveCeilingExclusions — resilience + caching', () => {
  beforeEach(() => {
    clearCeilingCache();
  });

  /** Db stub whose ceiling read counts calls; behavior controls the result. */
  function dbSelect(behavior: 'throws' | 'no-ceiling') {
    const counter = { ceilingReads: 0 };
    const db = {
      select: (cols?: Record<string, unknown>) => {
        if (cols && 'capabilityCeiling' in cols) {
          counter.ceilingReads += 1;
          return {
            from: () => ({
              where: () => ({
                limit: () =>
                  behavior === 'throws'
                    ? Promise.reject(new Error('column "capability_ceiling" does not exist'))
                    : Promise.resolve([{ capabilityCeiling: null }]),
              }),
            }),
          };
        }
        return {
          from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
        };
      },
    } as unknown as Parameters<typeof loadEffectiveCeilingExclusions>[0];
    return { db, counter };
  }

  it('returns null (no exclusions) when the ceiling column is absent — never throws', async () => {
    const { db } = dbSelect('throws');
    await expect(loadEffectiveCeilingExclusions(db, 't-throws' as never, 'u1')).resolves.toBeNull();
  });

  it('returns null when no ceiling is configured', async () => {
    const { db } = dbSelect('no-ceiling');
    await expect(loadEffectiveCeilingExclusions(db, 't-none' as never, 'u1')).resolves.toBeNull();
  });

  it('caches the ceiling read — a second call for the same tenant hits the cache', async () => {
    const { db, counter } = dbSelect('no-ceiling');
    await loadEffectiveCeilingExclusions(db, 't-cache' as never, 'u1');
    await loadEffectiveCeilingExclusions(db, 't-cache' as never, 'u2');
    expect(counter.ceilingReads).toBe(1);
  });

  it('clearCeilingCache forces a re-read', async () => {
    const { db, counter } = dbSelect('no-ceiling');
    await loadEffectiveCeilingExclusions(db, 't-clear' as never, 'u1');
    clearCeilingCache();
    await loadEffectiveCeilingExclusions(db, 't-clear' as never, 'u1');
    expect(counter.ceilingReads).toBe(2);
  });

  describe('error handling does not fail open', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Ceiling on the first read, then throws — plus a no-op grants read. */
    function dbCeilingThenThrows(ceiling: { excludedGroups: string[] }) {
      let ceilingReads = 0;
      return {
        select: (cols?: Record<string, unknown>) => {
          if (cols && 'capabilityCeiling' in cols) {
            ceilingReads += 1;
            const first = ceilingReads === 1;
            return {
              from: () => ({
                where: () => ({
                  limit: () =>
                    first
                      ? Promise.resolve([{ capabilityCeiling: ceiling }])
                      : Promise.reject(new Error('connection reset')),
                }),
              }),
            };
          }
          // grants read — no rows
          return { from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) };
        },
      } as unknown as Parameters<typeof loadEffectiveCeilingExclusions>[0];
    }

    it('a transient DB error keeps the last-known-good ceiling (never fails open)', async () => {
      vi.useFakeTimers();
      const db = dbCeilingThenThrows({ excludedGroups: ['compute.sandbox', 'code.agent'] });
      // 1) Load succeeds and caches the ceiling.
      await expect(
        loadEffectiveCeilingExclusions(db, 't-transient' as never, 'u1'),
      ).resolves.toEqual(['compute.sandbox', 'code.agent']);
      // 2) Expire the cache, then the DB read throws — must return last-known-good, NOT null.
      vi.advanceTimersByTime(31_000);
      await expect(
        loadEffectiveCeilingExclusions(db, 't-transient' as never, 'u1'),
      ).resolves.toEqual(['compute.sandbox', 'code.agent']);
    });

    it('an error with no prior value returns null uncached (migration window)', async () => {
      const { db, counter } = dbSelect('throws');
      await expect(loadEffectiveCeilingExclusions(db, 't-cold' as never, 'u1')).resolves.toBeNull();
      // Not cached → a second call re-reads (would pick up the ceiling once migrated).
      await expect(loadEffectiveCeilingExclusions(db, 't-cold' as never, 'u1')).resolves.toBeNull();
      expect(counter.ceilingReads).toBe(2);
    });
  });
});

/**
 * A tenant admin manages people, not spaces. "Give this user the sandbox" has
 * to hold wherever they work — including a personal space whose profile
 * deliberately omits it — or the governance page promises something it cannot
 * deliver.
 */
describe('applyUserCapabilityGrants', () => {
  const base = (
    allowed: { capabilityGroupId: string; accessMode: 'read' | 'write' }[],
    denied: { capabilityGroupId: string; accessMode: 'read' | 'write' }[] = [],
  ): RunAccessGrant => ({
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    capabilities: {
      allowedCapabilities: allowed,
      deniedCapabilities: denied,
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    resourceScopes: [],
  });

  it('adds a group the profile never had — the Personal Safe case', () => {
    const result = applyUserCapabilityGrants(
      base([{ capabilityGroupId: 'memory.store', accessMode: 'write' }]),
      ['compute.sandbox'],
    );

    expect(result.capabilities.allowedCapabilities).toContainEqual({
      capabilityGroupId: 'compute.sandbox',
      accessMode: 'write',
    });
    expect(result.capabilities.allowedCapabilities).toContainEqual({
      capabilityGroupId: 'memory.store',
      accessMode: 'write',
    });
  });

  it('lifts a ceiling denial for the granted group', () => {
    const result = applyUserCapabilityGrants(
      base(
        [{ capabilityGroupId: 'memory.store', accessMode: 'write' }],
        [
          { capabilityGroupId: 'compute.sandbox', accessMode: 'read' },
          { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
          { capabilityGroupId: 'code.repo', accessMode: 'write' },
        ],
      ),
      ['compute.sandbox'],
    );

    expect(
      result.capabilities.deniedCapabilities.some((c) => c.capabilityGroupId === 'compute.sandbox'),
    ).toBe(false);
    // An unrelated denial is untouched.
    expect(result.capabilities.deniedCapabilities).toContainEqual({
      capabilityGroupId: 'code.repo',
      accessMode: 'write',
    });
  });

  it('does not duplicate what the profile already allowed', () => {
    const result = applyUserCapabilityGrants(
      base([{ capabilityGroupId: 'compute.sandbox', accessMode: 'write' }]),
      ['compute.sandbox'],
    );

    expect(
      result.capabilities.allowedCapabilities.filter(
        (c) => c.capabilityGroupId === 'compute.sandbox' && c.accessMode === 'write',
      ),
    ).toHaveLength(1);
  });

  it('conveys capability groups only — never privilege or risk modifiers', () => {
    const result = applyUserCapabilityGrants(base([]), ['compute.sandbox']);

    expect(result.capabilities.allowPrivileged).toBe(false);
    expect(result.capabilities.allowedRiskModifiers).toEqual([]);
  });

  it('is a no-op with no grants', () => {
    const grant = base([{ capabilityGroupId: 'memory.store', accessMode: 'write' }]);
    expect(applyUserCapabilityGrants(grant, [])).toBe(grant);
  });
});
