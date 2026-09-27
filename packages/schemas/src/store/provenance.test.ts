import { describe, it, expect } from 'vitest';
import {
  StoreInstallSchema,
  StoreInstallArtifactSchema,
  StoreInstallClaimSchema,
  StoreInstallClaimantSchema,
  buildBundleClaimant,
  parseStoreInstallClaimant,
} from './provenance.js';

const SPACE_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function validInstall() {
  const installedAt = new Date().toISOString();
  return {
    spaceId: SPACE_ID,
    catalogId: 'kaggle-competition-optimizer',
    kind: 'skill' as const,
    installedVersion: 3,
    installedContentHash: 'abc123',
    state: 'installed' as const,
    installedAt,
    installedBy: USER_ID,
    updatedAt: installedAt,
    updatedBy: USER_ID,
  };
}

describe('StoreInstallSchema', () => {
  it('parses a fresh install row', () => {
    const parsed = StoreInstallSchema.parse(validInstall());
    expect(parsed.skippedVersion).toBeUndefined();
    expect(parsed.updatedAt).toBe(parsed.installedAt);
  });

  it('accepts skippedVersion and update audit fields', () => {
    const row = {
      ...validInstall(),
      skippedVersion: 4,
      updatedAt: new Date().toISOString(),
      updatedBy: OTHER_USER_ID,
    };
    expect(StoreInstallSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a non-uuid installer', () => {
    const row = { ...validInstall(), installedBy: 'user-1' };
    expect(StoreInstallSchema.safeParse(row).success).toBe(false);
  });

  it('rejects an unknown state', () => {
    const row = { ...validInstall(), state: 'uninstalled' };
    expect(StoreInstallSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a non-uuid spaceId', () => {
    const row = { ...validInstall(), spaceId: 'not-a-uuid' };
    expect(StoreInstallSchema.safeParse(row).success).toBe(false);
  });
});

describe('StoreInstallArtifactSchema', () => {
  it('parses each artifact type', () => {
    for (const artifactType of [
      'skill',
      'api_definition',
      'api_binding',
      'mcp_definition',
      'mcp_binding',
      'memory_doc',
      'ui_artifact',
    ] as const) {
      const row = {
        spaceId: SPACE_ID,
        catalogId: 'my-bundle',
        artifactType,
        artifactKey: 'some-key',
        artifactId: 'some-id',
        installedContentHash: 'abc123',
        preservation: 'replace_on_update' as const,
      };
      expect(StoreInstallArtifactSchema.safeParse(row).success).toBe(true);
    }
  });

  it('rejects an unknown preservation policy', () => {
    const row = {
      spaceId: SPACE_ID,
      catalogId: 'my-bundle',
      artifactType: 'memory_doc',
      artifactKey: '/policy/notes.md',
      artifactId: 'doc-1',
      installedContentHash: 'abc123',
      preservation: 'merge',
    };
    expect(StoreInstallArtifactSchema.safeParse(row).success).toBe(false);
  });
});

describe('StoreInstallClaimSchema', () => {
  it("accepts 'direct' and 'bundle:<id>' claimants", () => {
    for (const claimedBy of ['direct', 'bundle:kaggle-competition']) {
      const row = { spaceId: SPACE_ID, catalogId: 'kaggle-competition-optimizer', claimedBy };
      expect(StoreInstallClaimSchema.safeParse(row).success).toBe(true);
    }
  });

  it.each([['bundle:'], ['bundle:Not A Slug'], ['other:thing'], ['']])(
    'rejects claimant %j',
    (claimedBy) => {
      expect(StoreInstallClaimantSchema.safeParse(claimedBy).success).toBe(false);
    },
  );

  it('round-trips through the claimant helpers', () => {
    const claimant = buildBundleClaimant('kaggle-competition');
    expect(StoreInstallClaimantSchema.safeParse(claimant).success).toBe(true);
    expect(parseStoreInstallClaimant(claimant)).toEqual({
      kind: 'bundle',
      bundleCatalogId: 'kaggle-competition',
    });
    expect(parseStoreInstallClaimant('direct')).toEqual({ kind: 'direct' });
    expect(parseStoreInstallClaimant('bundle:')).toBeNull();
    expect(parseStoreInstallClaimant('other:thing')).toBeNull();
  });
});
