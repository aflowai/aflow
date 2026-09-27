import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SkillCapabilityDependency } from '@aflow/schemas';

// Only the transaction boundary is faked — the real drizzle table objects are
// kept so the tx double can tell the queries apart the way postgres would.
vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: () => ({ schemaName: 't_test' }),
    withTenantSchema: async <T>(
      _db: unknown,
      _ctx: unknown,
      cb: (tx: unknown) => Promise<T>,
    ): Promise<T> => cb(makeTx()),
  };
});

const {
  spaces,
  repoBindings,
  providerCredentials,
  spaceCapabilityAssignments,
  capabilityProfiles,
  tenants,
} = await import('@aflow/database');
const {
  loadAvailableCapabilitySet,
  loadAvailableCapabilities,
  applyCapabilityStatuses,
  deriveWorkflowPolicyPrefixes,
} = await import('../skillProjectionReconciler.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = 'b0000000-0000-0000-0000-000000000001';

interface SpaceFixture {
  computePolicy: { enabled: boolean } | null;
  codePolicy: { enabled: boolean } | null;
  /** Simulates the tenant migration not having run yet on this deployment. */
  codePolicyColumnMissing: boolean;
  readyRepos: number;
  laneProviders: string[];
  /** `undefined` = no assignment row (role default decides). */
  profileAllowedCapabilities: unknown;
  /** Applied to the assigned profile AND the role defaults. */
  profileDeniedCapabilities: unknown;
  profileAllowedRiskModifiers: unknown;
  /** The tenant's run-capable role defaults, consulted only when unassigned. */
  roleDefaults: Array<{ defaultForRole: string; allowedCapabilities: unknown }>;
  /** `tenants.capability_ceiling` — null = no ceiling (the default posture). */
  capabilityCeiling: unknown;
  /** Simulates the public migration not having run yet on this deployment. */
  ceilingColumnMissing: boolean;
}

let fixture: SpaceFixture;

/**
 * A `capability_profiles` row as the loader now reads it — every column
 * `enforceGrant` consults, not just the allowlist.
 */
function profileRow(allowedCapabilities: unknown): Record<string, unknown> {
  return {
    name: 'Fixture Profile',
    allowedCapabilities,
    deniedCapabilities: fixture.profileDeniedCapabilities,
    allowedRiskModifiers: fixture.profileAllowedRiskModifiers,
    deniedRiskModifiers: [],
    allowPrivileged: false,
  };
}

function rowsFor(table: unknown, cols: Record<string, unknown>): unknown[] {
  if (table === repoBindings) return Array.from({ length: fixture.readyRepos }, () => ({}));
  if (table === providerCredentials)
    return fixture.laneProviders.map((providerId) => ({ providerId }));
  if (table === spaceCapabilityAssignments) {
    return fixture.profileAllowedCapabilities === undefined
      ? []
      : [profileRow(fixture.profileAllowedCapabilities)];
  }
  if (table === capabilityProfiles) {
    return fixture.roleDefaults.map((row) => ({
      defaultForRole: row.defaultForRole,
      ...profileRow(row.allowedCapabilities),
    }));
  }
  if (table === tenants) {
    if (fixture.ceilingColumnMissing) {
      throw new Error('column "capability_ceiling" does not exist');
    }
    return [{ capabilityCeiling: fixture.capabilityCeiling }];
  }
  if (table === spaces) {
    if ('codePolicy' in cols) {
      if (fixture.codePolicyColumnMissing) {
        throw new Error('column "code_policy" does not exist');
      }
      return [{ codePolicy: fixture.codePolicy }];
    }
    return [{ computePolicy: fixture.computePolicy, ownerId: null }];
  }
  return [];
}

function makeTx(): PostgresJsDatabase {
  return {
    select: (cols: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const build = () => {
          const rows = rowsFor(table, cols);
          const chain = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          chain.limit = (n: number) => Promise.resolve(rows.slice(0, n));
          return chain;
        };
        return {
          where: build,
          innerJoin: () => ({ where: build }),
        };
      },
    }),
  } as unknown as PostgresJsDatabase;
}

function load(): Promise<Set<string>> {
  return loadAvailableCapabilitySet({
    db: {} as PostgresJsDatabase,
    tenantId: TENANT,
    spaceId: SPACE,
  });
}

/**
 * Full-Access-shaped allowlist. Both lane groups are granted at read AND
 * write: `code.agent.review` and `code.repo.describe` are read operations, and
 * `enforceGrant` matches the access mode exactly, so a write-only allowlist
 * does not cover the coding lane (migrations 120/126 grant both to Full
 * Access for that reason).
 */
const FULL_PROFILE = [
  { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
  { capabilityGroupId: 'code.agent', accessMode: 'write' },
  { capabilityGroupId: 'code.agent', accessMode: 'read' },
  { capabilityGroupId: 'code.repo', accessMode: 'write' },
  { capabilityGroupId: 'code.repo', accessMode: 'read' },
];

/** Personal-Safe-shaped allowlist: lane groups absent, everything else present. */
const SAFE_PROFILE = [
  { capabilityGroupId: 'memory.store', accessMode: 'write' },
  { capabilityGroupId: 'api.http', accessMode: 'write' },
];

/** Every seeded system profile carries this (migration 020). */
const SEEDED_RISK_MODIFIERS = ['external_side_effect'];

/**
 * The seeded run-capable role defaults (migrations 020/035/120/126): both
 * carry the compute sandbox, but only `Full Access` carries the coding lane
 * for writing — `Standard` holds it read-only.
 */
const SEEDED_ROLE_DEFAULTS = [
  { defaultForRole: 'admin', allowedCapabilities: FULL_PROFILE },
  {
    defaultForRole: 'editor',
    allowedCapabilities: [
      { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
      { capabilityGroupId: 'code.agent', accessMode: 'read' },
      { capabilityGroupId: 'code.repo', accessMode: 'read' },
    ],
  },
];

beforeEach(() => {
  fixture = {
    computePolicy: { enabled: true },
    codePolicy: null,
    codePolicyColumnMissing: false,
    readyRepos: 0,
    laneProviders: [],
    profileAllowedCapabilities: undefined,
    profileDeniedCapabilities: [],
    profileAllowedRiskModifiers: SEEDED_RISK_MODIFIERS,
    roleDefaults: SEEDED_ROLE_DEFAULTS,
    capabilityCeiling: null,
    ceilingColumnMissing: false,
  };
});

describe('loadAvailableCapabilitySet — coding-lane policy', () => {
  it('omits `code` when the space has no code policy', async () => {
    expect(await load()).not.toContain('code');
  });

  it('omits `code` when the policy exists but is disabled', async () => {
    fixture.codePolicy = { enabled: false };
    expect(await load()).not.toContain('code');
  });

  it('offers `code` only once a space admin enables the policy', async () => {
    // Assigned explicitly so this exercises the policy switch alone — an
    // unassigned space answers the separate role-default question below.
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.codePolicy = { enabled: true };
    expect(await load()).toContain('code');
  });

  it('treats an unreadable policy column as disabled without losing the rest of the set', async () => {
    fixture.codePolicyColumnMissing = true;
    fixture.readyRepos = 1;
    const available = await load();
    expect(available).not.toContain('code');
    expect(available).toContain('code_repo');
  });

  it('keeps the compute policy on its own switch', async () => {
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.computePolicy = { enabled: false };
    fixture.codePolicy = { enabled: true };
    const available = await load();
    expect(available).toContain('code');
    expect(available).not.toContain('compute');
  });
});

describe('loadAvailableCapabilities — capability profile gate (Plan 302)', () => {
  function loadFull() {
    return loadAvailableCapabilities({
      db: {} as PostgresJsDatabase,
      tenantId: TENANT,
      spaceId: SPACE,
    });
  }

  it('withholds code from a write-only profile — its read operations are still denied', async () => {
    // `enforceGrant` matches the access mode exactly, so `code.agent.review`
    // and `code.repo.describe` are refused by an allowlist carrying only
    // `:write`. Reducing the lane to its write groups reported this ready.
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = [
      { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
      { capabilityGroupId: 'code.agent', accessMode: 'write' },
      { capabilityGroupId: 'code.repo', accessMode: 'write' },
    ];
    const { available, withheldByProfile } = await loadFull();
    expect(available).toContain('compute');
    expect(available).not.toContain('code');
    expect(withheldByProfile.get('code')).toEqual(
      expect.arrayContaining(['code.agent', 'code.repo']),
    );
  });

  it('withholds a lane its profile denies outright, even though the allowlist covers it', async () => {
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.profileDeniedCapabilities = [
      { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
    ];
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByProfile.get('compute')).toEqual(['compute.sandbox']);
  });

  it('withholds a lane whose risk modifier the profile does not allow', async () => {
    // `compute.sandbox.exec` carries `external_side_effect`; a profile that
    // does not allow the modifier is refused regardless of its allowlist.
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.profileAllowedRiskModifiers = [];
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByProfile.get('compute')).toEqual(['compute.sandbox']);
  });

  it('withholds compute when the assigned profile lacks the sandbox write group, even with the policy on', async () => {
    fixture.profileAllowedCapabilities = SAFE_PROFILE;
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByProfile.get('compute')).toEqual(['compute.sandbox']);
  });

  it('withholds code when the profile lacks the lane write groups', async () => {
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = SAFE_PROFILE;
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('code');
    expect(withheldByProfile.get('code')).toEqual(
      expect.arrayContaining(['code.agent', 'code.repo']),
    );
  });

  it('offers both lanes when the profile covers their write groups', async () => {
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    const { available, withheldByProfile } = await loadFull();
    expect(available).toContain('compute');
    expect(available).toContain('code');
    expect(withheldByProfile.size).toBe(0);
  });

  it('holds an unassigned space to what EVERY run-capable role default covers', async () => {
    // With no assignment the grant compiles against the caller's role default,
    // and readiness cannot see which role that is. The seeded defaults disagree
    // about the coding lane (`Standard` has it read-only), so claiming it would
    // report ready what enforcement then denies — the exact failure this gate
    // exists to remove. Compute, which both defaults carry, stays available.
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = undefined;
    const { available, withheldByProfile } = await loadFull();
    expect(available).toContain('compute');
    expect(available).not.toContain('code');
    expect(withheldByProfile.get('code')).toEqual(
      expect.arrayContaining(['code.agent', 'code.repo']),
    );
  });

  it('records the host lane only where a machine can pair', async () => {
    const saved = process.env['PHOENIX_HOST_REDIS_PASSWORD'];
    try {
      delete process.env['PHOENIX_HOST_REDIS_PASSWORD'];
      const absent = await loadFull();
      expect(absent.available.has('host')).toBe(false);
      expect(absent.withheldByProfile.has('host')).toBe(false);

      process.env['PHOENIX_HOST_REDIS_PASSWORD'] = 'paired';
      const present = await loadFull();
      expect(present.available.has('host') || present.withheldByProfile.has('host')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['PHOENIX_HOST_REDIS_PASSWORD'];
      else process.env['PHOENIX_HOST_REDIS_PASSWORD'] = saved;
    }
  });

  it('offers a lane every role default covers, unassigned', async () => {
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = undefined;
    fixture.roleDefaults = [
      { defaultForRole: 'admin', allowedCapabilities: FULL_PROFILE },
      { defaultForRole: 'editor', allowedCapabilities: FULL_PROFILE },
    ];
    const { available, withheldByProfile } = await loadFull();
    expect(available).toContain('compute');
    expect(available).toContain('code');
    expect(withheldByProfile.size).toBe(0);
  });

  it('withholds every lane when a run-capable role default is missing entirely', async () => {
    // Nothing to resolve the caller's authority against, so readiness cannot
    // claim coverage; over-reporting `needsSetup` is the safe direction.
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = undefined;
    fixture.roleDefaults = [{ defaultForRole: 'admin', allowedCapabilities: FULL_PROFILE }];
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('compute');
    expect(available).not.toContain('code');
    expect(withheldByProfile.has('compute')).toBe(true);
  });

  it('treats an unparseable allowlist as no restriction rather than bricking readiness', async () => {
    fixture.profileAllowedCapabilities = 'garbage';
    const { available, withheldByProfile } = await loadFull();
    expect(available).toContain('compute');
    expect(withheldByProfile.size).toBe(0);
  });

  it('reports the profile gap even while the policy is also off — the profile is the harder remedy', async () => {
    fixture.computePolicy = { enabled: false };
    fixture.profileAllowedCapabilities = SAFE_PROFILE;
    const { available, withheldByProfile } = await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByProfile.has('compute')).toBe(true);
  });
});

describe('loadAvailableCapabilities — tenant capability ceiling (Plan 302)', () => {
  function loadFull() {
    return loadAvailableCapabilities({
      db: {} as PostgresJsDatabase,
      tenantId: TENANT,
      spaceId: SPACE,
    });
  }

  it('withholds compute when the ceiling excludes the sandbox, even on a profile that allows it', async () => {
    // The ceiling SUBTRACTS at grant-compile time, so a profile granting the
    // group is not the last word — reporting available here is a false ready.
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.capabilityCeiling = { excludedGroups: ['compute.sandbox'] };
    const { available, withheldByProfile, withheldByCeiling, withheldByProfileAlone } =
      await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByProfile.get('compute')).toEqual(['compute.sandbox']);
    expect(withheldByCeiling.get('compute')).toEqual(['compute.sandbox']);
    // The profile itself grants the group, so only the ceiling withholds it —
    // the distinction a caller needs to name one remedy rather than two.
    expect(withheldByProfileAlone.has('compute')).toBe(false);
  });

  it('separates the two axes when the ceiling AND the profile withhold the same group', async () => {
    // Folding these together loses the overlap: a caller subtracting the
    // ceiling groups would see an empty profile gap and report ceiling-only.
    fixture.profileAllowedCapabilities = SAFE_PROFILE;
    fixture.capabilityCeiling = { excludedGroups: ['compute.sandbox'] };
    const { available, withheldByCeiling, withheldByProfileAlone } = await loadFull();
    expect(available).not.toContain('compute');
    expect(withheldByCeiling.get('compute')).toEqual(['compute.sandbox']);
    expect(withheldByProfileAlone.get('compute')).toEqual(['compute.sandbox']);
  });

  it('withholds code when the ceiling excludes a lane group the profile grants', async () => {
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.capabilityCeiling = { excludedGroups: ['code.agent'] };
    const { available, withheldByCeiling } = await loadFull();
    expect(available).not.toContain('code');
    expect(withheldByCeiling.get('code')).toEqual(['code.agent']);
  });

  it('leaves both lanes available when no ceiling is set', async () => {
    fixture.codePolicy = { enabled: true };
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    const { available, withheldByCeiling } = await loadFull();
    expect(available).toContain('compute');
    expect(available).toContain('code');
    expect(withheldByCeiling.size).toBe(0);
  });

  it('ignores a ceiling that excludes groups unrelated to the lanes', async () => {
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.capabilityCeiling = { excludedGroups: ['memory.store'] };
    const { available, withheldByCeiling } = await loadFull();
    expect(available).toContain('compute');
    expect(withheldByCeiling.size).toBe(0);
  });

  it('reads a malformed ceiling as no ceiling rather than withholding everything', async () => {
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.capabilityCeiling = { excludedGroups: 'compute.sandbox' };
    const { available } = await loadFull();
    expect(available).toContain('compute');
  });

  it('treats an unreadable ceiling column as no ceiling without losing the rest of the set', async () => {
    // A deploy can land ahead of the public migration; a throw here would
    // brick every readiness surface in the space.
    fixture.profileAllowedCapabilities = FULL_PROFILE;
    fixture.ceilingColumnMissing = true;
    fixture.readyRepos = 1;
    const { available } = await loadFull();
    expect(available).toContain('compute');
    expect(available).toContain('code_repo');
  });
});

describe('deriveWorkflowPolicyPrefixes', () => {
  it('reports the policy-gated prefixes a workflow actually references', () => {
    expect(
      deriveWorkflowPolicyPrefixes([
        { operation: 'code.agent.run' },
        { operation: 'code.repo.push' },
        { operation: 'compute.sandbox.exec' },
        { operation: 'ai.text.generate' },
        { operation: null },
        {},
      ]),
    ).toEqual(['code', 'compute']);
  });

  it('reports nothing for a workflow that touches no gated lane', () => {
    expect(deriveWorkflowPolicyPrefixes([{ operation: 'memory.store.put' }])).toEqual([]);
  });

  it('sees a gated lane granted to an agent task, not only an operation task', () => {
    expect(
      deriveWorkflowPolicyPrefixes([
        { context: { capabilities: { operations: ['compute.sandbox.exec'] } } },
        { context: { tools: ['code.repo.describe'] } },
        { context: { capabilities: { operations: ['ai.text.generate'] } } },
        { context: 'not-an-object' },
      ]),
    ).toEqual(['compute', 'code']);
  });
});

describe('applyCapabilityStatuses — code operations', () => {
  it('flips a code.* dependency to needs_binding while the lane is off', () => {
    const deps: SkillCapabilityDependency[] = [
      {
        capabilityType: 'operation',
        capabilityId: 'code.agent.run',
        taskIds: ['implement'],
        status: 'ready',
      },
    ];
    applyCapabilityStatuses(deps, ['code'], new Map());
    expect(deps[0]!.status).toBe('needs_binding');
  });

  it('leaves a code.* dependency ready once the lane is on', () => {
    const deps: SkillCapabilityDependency[] = [
      {
        capabilityType: 'operation',
        capabilityId: 'code.agent.run',
        taskIds: ['implement'],
        status: 'ready',
      },
    ];
    applyCapabilityStatuses(deps, [], new Map());
    expect(deps[0]!.status).toBe('ready');
  });
});
