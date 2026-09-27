import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { MemoryDocRepository } from '@aflow/database';
import { getSkillBundleEntry } from '@aflow/platform-artifacts';

// Mock ONLY the space-dependent DB capability read. Everything else — the real
// coding bundle, real getSkillCatalogEntry, real deriveRequiredCapabilities —
// runs unmocked, so the test proves the wiring (coding skills derive code_repo
// → a designate_repo row fires) without needing a live repo_bindings row.
// The double answers `available.has(token)` from a missing-token fixture, so
// each case states what is absent in the space rather than enumerating the
// full availability set.
const missingTokens = new Set<string>();
const withheldByProfile = new Map<string, string[]>();
const withheldByCeiling = new Map<string, string[]>();
const withheldByProfileAlone = new Map<string, string[]>();

vi.mock('../skillProjectionReconciler.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    loadAvailableCapabilities: async () => ({
      available: { has: (token: string) => !missingTokens.has(token) } as Set<string>,
      codeLane: 'present' as const,
      withheldByProfile,
      withheldByCeiling,
      withheldByProfileAlone,
    }),
  };
});

const { generatePostInstallManifest } = await import('../stagedChange/bundleInstallManifest.js');

const SPACE = '00000000-0000-0000-0000-000000000001';
const TENANT = '11111111-1111-1111-1111-111111111111';
const fakeTx = {} as PostgresJsDatabase;
const fakeRepo = {} as MemoryDocRepository;

function codingBundle() {
  const bundle = getSkillBundleEntry('coding-pr-loop');
  if (!bundle) throw new Error('coding-pr-loop bundle must exist');
  return bundle;
}

function localReviewBundle() {
  const bundle = getSkillBundleEntry('local-code-review');
  if (!bundle) throw new Error('local-code-review bundle must exist');
  return bundle;
}

beforeEach(() => {
  missingTokens.clear();
  withheldByProfile.clear();
  withheldByCeiling.clear();
  withheldByProfileAlone.clear();
});

describe('Plan 225 — derived designate_repo post-install task', () => {
  it('emits a designate_repo task when the space has NO ready repo (code_repo unmet)', async () => {
    missingTokens.add('code_repo').add('github');

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const designate = manifest.filter((t) => t.kind === 'designate_repo');
    expect(designate).toHaveLength(1);
    expect(designate[0]?.required).toBe(true);
    // The coding bundle ships no binding templates, so no credential rows ever
    // appear — the designate_repo row is the only outstanding work.
    expect(manifest.every((t) => t.kind !== 'fill_credentials')).toBe(true);
  });

  it('omits designate_repo when a ready repo exists (code_repo satisfied)', async () => {
    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    expect(manifest.some((t) => t.kind === 'designate_repo')).toBe(false);
  });

  it('tells the operator to switch the coding lane on when the space policy gates it', async () => {
    missingTokens.add('code').add('code_repo');

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const policy = manifest.filter((t) => t.kind === 'enable_space_policy');
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ policy: 'code', required: true });
    // It leads the checklist: no repo or key the operator wires up runs the
    // skill while the lane itself is off.
    expect(manifest[0]?.kind).toBe('enable_space_policy');
  });

  it('omits the policy row once the lane is on', async () => {
    missingTokens.add('code_repo');

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    expect(manifest.some((t) => t.kind === 'enable_space_policy')).toBe(false);
  });

  it('does not emit designate_repo for an unmet capability that is not code_repo', async () => {
    missingTokens.add('github');

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    expect(manifest.some((t) => t.kind === 'designate_repo')).toBe(false);
  });
});

describe('Plan 302 — assign_capability_profile post-install task', () => {
  it('emits assign_capability_profile instead of enable_space_policy when the profile withholds the lane', async () => {
    missingTokens.add('code');
    withheldByProfile.set('code', ['code.agent', 'code.repo']);
    withheldByProfileAlone.set('code', ['code.agent', 'code.repo']);

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const profileTasks = manifest.filter((t) => t.kind === 'assign_capability_profile');
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0]).toMatchObject({
      policy: 'code',
      remedy: 'profile',
      missingCapabilityGroups: ['code.agent', 'code.repo'],
      required: true,
    });
    expect(manifest.some((t) => t.kind === 'enable_space_policy')).toBe(false);
    const description = (profileTasks[0] as { description: string }).description;
    expect(description).toContain("space's capability profile");
    expect(description).not.toContain('ceiling');
  });

  it('names the ceiling — not a profile reassignment — when the ceiling is what withholds the lane', async () => {
    // The ceiling ANDs over every profile, so pointing a tenant admin at Space
    // Assignments would send them to a setting that cannot move.
    missingTokens.add('code');
    withheldByProfile.set('code', ['code.agent', 'code.repo']);
    withheldByCeiling.set('code', ['code.agent', 'code.repo']);

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const profileTasks = manifest.filter((t) => t.kind === 'assign_capability_profile');
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0]).toMatchObject({ remedy: 'ceiling' });
    const description = (profileTasks[0] as { description: string }).description;
    expect(description).toContain('tenant capability ceiling');
    expect(description).toContain('code.agent');
    expect(description).toContain('Capability Governance');
  });

  it('names BOTH remedies when the ceiling and the profile withhold different groups', async () => {
    // Lifting the ceiling alone still leaves code.repo withheld by the profile,
    // so reporting either remedy on its own reads as sufficient when it is not.
    missingTokens.add('code');
    withheldByProfile.set('code', ['code.agent', 'code.repo']);
    withheldByCeiling.set('code', ['code.agent']);
    withheldByProfileAlone.set('code', ['code.repo']);

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const profileTasks = manifest.filter((t) => t.kind === 'assign_capability_profile');
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0]).toMatchObject({ remedy: 'both' });
    const description = (profileTasks[0] as { description: string }).description;
    expect(description).toContain('Capability Governance');
    expect(description).toContain('Space Assignments');
    expect(description).toContain('code.agent');
    expect(description).toContain('code.repo');
  });

  it('names BOTH remedies when the two gates withhold the SAME group', async () => {
    // The overlap is the case a set difference loses: subtracting the ceiling
    // groups leaves an empty profile gap, which reads as ceiling-only, and the
    // operator lifts the ceiling to find the profile still blocking.
    missingTokens.add('code');
    withheldByProfile.set('code', ['code.agent']);
    withheldByCeiling.set('code', ['code.agent']);
    withheldByProfileAlone.set('code', ['code.agent']);

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const profileTasks = manifest.filter((t) => t.kind === 'assign_capability_profile');
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0]).toMatchObject({ remedy: 'both' });
    const description = (profileTasks[0] as { description: string }).description;
    expect(description).toContain('Capability Governance');
    expect(description).toContain('Space Assignments');
  });

  it('keeps enable_space_policy for a lane the profile covers but the policy switches off', async () => {
    missingTokens.add('code');

    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const policy = manifest.filter((t) => t.kind === 'enable_space_policy');
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ policy: 'code', required: true });
    expect(manifest.some((t) => t.kind === 'assign_capability_profile')).toBe(false);
  });

  it('emits neither row when the space covers the lane', async () => {
    const manifest = await generatePostInstallManifest({
      bundle: codingBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    expect(manifest.some((t) => t.kind === 'assign_capability_profile')).toBe(false);
    expect(manifest.some((t) => t.kind === 'enable_space_policy')).toBe(false);
  });
});

describe('Plan 313 — pair_machine post-install task', () => {
  it('asks for a paired machine — not a space setting — when the host lane is unmet', async () => {
    missingTokens.add('host');

    const manifest = await generatePostInstallManifest({
      bundle: localReviewBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const pair = manifest.filter((t) => t.kind === 'pair_machine');
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({ required: true });
    expect((pair[0] as { description: string }).description).toContain('This Computer');
    // The host lane has no space policy behind it, so the row that points at
    // space settings must never be the one emitted for it.
    expect(manifest.some((t) => t.kind === 'enable_space_policy')).toBe(false);
  });

  it('omits the row once the machine is paired', async () => {
    const manifest = await generatePostInstallManifest({
      bundle: localReviewBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    expect(manifest.some((t) => t.kind === 'pair_machine')).toBe(false);
  });

  it('still names the profile remedy when the capability profile withholds the host lane', async () => {
    missingTokens.add('host');
    withheldByProfile.set('host', ['host.file', 'host.process']);
    withheldByProfileAlone.set('host', ['host.file', 'host.process']);

    const manifest = await generatePostInstallManifest({
      bundle: localReviewBundle(),
      tenantId: TENANT,
      spaceId: SPACE,
      tx: fakeTx,
      repo: fakeRepo,
    });

    const profileTasks = manifest.filter((t) => t.kind === 'assign_capability_profile');
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0]).toMatchObject({ policy: 'host', remedy: 'profile' });
    expect(manifest.some((t) => t.kind === 'pair_machine')).toBe(false);
  });
});
