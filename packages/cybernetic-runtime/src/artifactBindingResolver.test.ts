import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @aflow/database BEFORE importing the resolver — its top-level
// imports (`artifactBindings`, `uiArtifacts`, `withTenantSchema`,
// `createTenantContext`) need to resolve to test doubles.
vi.mock('@aflow/database', () => {
  return {
    artifactBindings: { __tag: 'artifactBindings' },
    uiArtifacts: { __tag: 'uiArtifacts' },
    uiArtifactVersions: { __tag: 'uiArtifactVersions' },
    createTenantContext: (tenantId: string) => ({ tenantId }),
    withTenantSchema: async <T>(
      _db: unknown,
      _ctx: unknown,
      cb: (tx: unknown) => Promise<T>,
    ): Promise<T> => cb(makeTx()),
  };
});

vi.mock('drizzle-orm', () => {
  return {
    and: (...args: unknown[]) => ({ __op: 'and', args }),
    eq: (col: unknown, value: unknown) => ({ __op: 'eq', col, value }),
  };
});

import {
  resolveArtifactBinding,
  invalidateArtifactBindingCache,
  getArtifactBundleProvenance,
  _getCacheEntryForTest,
} from './artifactBindingResolver.js';

// ============================================================================
// Tiny tx mock that returns whatever the test queues up.
// ============================================================================

interface Row {
  artifactId: string;
  bundleArtifactKey: string;
  enabled: boolean;
  currentVersion: number;
}

let nextRows: Row[] = [];
let selectCallCount = 0;

let nextRowsQueue: unknown[][] = [];

function makeTx() {
  // The resolver chains `.select().from().innerJoin().where().limit()`;
  // the provenance helper's version-table query uses `.select().from().where().limit()`
  // (no innerJoin). Make both chains return whatever's next.
  const finalize = () => {
    selectCallCount += 1;
    if (nextRowsQueue.length > 0) {
      return Promise.resolve(nextRowsQueue.shift());
    }
    return Promise.resolve(nextRows);
  };
  const whereStep = () => ({ limit: () => finalize() });
  const fromBranches = () => ({
    innerJoin: () => ({ where: whereStep }),
    where: whereStep,
  });
  return {
    select() {
      return { from: fromBranches };
    },
  };
}

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = 'b0000000-0000-0000-0000-000000000001';
const ARTIFACT_ID = 'c0000000-0000-0000-0000-000000000001';

beforeEach(() => {
  invalidateArtifactBindingCache();
  nextRows = [];
  nextRowsQueue = [];
  selectCallCount = 0;
});

describe('resolveArtifactBinding', () => {
  it('returns null when the binding does not exist', async () => {
    nextRows = [];
    const result = await resolveArtifactBinding({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'alpaca',
      bindingId: 'portfolio-card',
    });
    expect(result).toBeNull();
    expect(selectCallCount).toBe(1);
  });

  it('returns the resolution row when the binding exists', async () => {
    nextRows = [
      {
        artifactId: ARTIFACT_ID,
        bundleArtifactKey: 'alpaca:portfolio-card',
        enabled: true,
        currentVersion: 1,
      },
    ];
    const result = await resolveArtifactBinding({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'alpaca',
      bindingId: 'portfolio-card',
    });
    expect(result).toEqual({
      artifactId: ARTIFACT_ID,
      bundleArtifactKey: 'alpaca:portfolio-card',
      currentVersion: 1,
      enabled: true,
    });
  });

  it('caches the resolution and skips the DB on the second call', async () => {
    nextRows = [
      {
        artifactId: ARTIFACT_ID,
        bundleArtifactKey: 'alpaca:portfolio-card',
        enabled: true,
        currentVersion: 1,
      },
    ];
    const args = {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'alpaca',
      bindingId: 'portfolio-card',
    };
    await resolveArtifactBinding({} as never, args);
    await resolveArtifactBinding({} as never, args);
    await resolveArtifactBinding({} as never, args);
    expect(selectCallCount).toBe(1); // only the first call hit the DB
  });

  it('caches null lookups (a missing binding is a stable answer)', async () => {
    nextRows = [];
    const args = {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'unknown',
      bindingId: 'nope',
    };
    await resolveArtifactBinding({} as never, args);
    await resolveArtifactBinding({} as never, args);
    expect(selectCallCount).toBe(1);
    expect(_getCacheEntryForTest(args)?.value).toBeNull();
  });

  it('partitions cache by tenant, space, bundle, and binding', async () => {
    nextRows = [
      {
        artifactId: ARTIFACT_ID,
        bundleArtifactKey: 'alpaca:portfolio-card',
        enabled: true,
        currentVersion: 1,
      },
    ];
    const base = {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'alpaca',
      bindingId: 'portfolio-card',
    };
    await resolveArtifactBinding({} as never, base);
    await resolveArtifactBinding({} as never, { ...base, bindingId: 'other-card' });
    await resolveArtifactBinding({} as never, { ...base, bundleId: 'other-bundle' });
    await resolveArtifactBinding({} as never, {
      ...base,
      spaceId: 'b0000000-0000-0000-0000-000000000002',
    });
    expect(selectCallCount).toBe(4);
  });

  it('invalidate(args) clears one entry only', async () => {
    nextRows = [
      {
        artifactId: ARTIFACT_ID,
        bundleArtifactKey: 'alpaca:portfolio-card',
        enabled: true,
        currentVersion: 1,
      },
    ];
    const a = {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      bundleId: 'alpaca',
      bindingId: 'portfolio-card',
    };
    const b = { ...a, bindingId: 'other-card' };
    await resolveArtifactBinding({} as never, a);
    await resolveArtifactBinding({} as never, b);
    expect(selectCallCount).toBe(2);
    invalidateArtifactBindingCache(a);
    await resolveArtifactBinding({} as never, a);
    await resolveArtifactBinding({} as never, b);
    expect(selectCallCount).toBe(3); // a hit DB again; b stayed cached
  });
});

describe('getArtifactBundleProvenance', () => {
  it('returns null when the artifact has no binding (operator-owned)', async () => {
    nextRowsQueue = [[]]; // joined lookup misses
    const result = await getArtifactBundleProvenance({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result).toBeNull();
  });

  it('returns divergedFromBundle=false when installed_hash equals current version hash', async () => {
    const sameHash = 'a'.repeat(64);
    nextRowsQueue = [
      // join: binding + head row
      [
        {
          bundleId: 'alpaca-portfolio-companion',
          bindingId: 'portfolio-review-card',
          installedContentHash: sameHash,
          currentVersion: 1,
        },
      ],
      // version row lookup
      [{ contentHash: sameHash }],
    ];
    const result = await getArtifactBundleProvenance({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result).toEqual({
      bundleId: 'alpaca-portfolio-companion',
      bindingId: 'portfolio-review-card',
      installedContentHash: sameHash,
      currentContentHash: sameHash,
      divergedFromBundle: false,
    });
  });

  it('returns divergedFromBundle=true when the operator has pushed a new version', async () => {
    const installedHash = 'a'.repeat(64);
    const currentHash = 'b'.repeat(64);
    nextRowsQueue = [
      [
        {
          bundleId: 'alpaca-portfolio-companion',
          bindingId: 'portfolio-review-card',
          installedContentHash: installedHash,
          currentVersion: 2,
        },
      ],
      [{ contentHash: currentHash }],
    ];
    const result = await getArtifactBundleProvenance({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result?.divergedFromBundle).toBe(true);
    expect(result?.installedContentHash).toBe(installedHash);
    expect(result?.currentContentHash).toBe(currentHash);
  });

  it('returns divergedFromBundle=null for legacy rows missing installed_content_hash (pre-Migration 96)', async () => {
    nextRowsQueue = [
      [
        {
          bundleId: 'alpaca-portfolio-companion',
          bindingId: 'portfolio-review-card',
          installedContentHash: null,
          currentVersion: 3,
        },
      ],
      [{ contentHash: 'c'.repeat(64) }],
    ];
    const result = await getArtifactBundleProvenance({} as never, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
    });
    expect(result?.divergedFromBundle).toBeNull();
    expect(result?.installedContentHash).toBeNull();
  });
});
