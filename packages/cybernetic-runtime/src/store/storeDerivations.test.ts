import { describe, it, expect } from 'vitest';
import { CatalogEntrySchema, type CatalogEntry, type StoreInstall } from '@aflow/schemas';
import { getCatalogEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';
import type { TenantStoreShelfPolicy } from '@aflow/database';
import { skillBundleContentHash } from './artifactContent.js';
import {
  deriveApiConnectorCredentialSlots,
  deriveApiConnectorSetupChecklist,
  deriveInstallProvenance,
  deriveInstalledState,
  deriveListingRequirements,
  derivePlannedArtifacts,
  isListingOnTenantShelf,
  searchListableEntries,
  selectListableEntries,
  toStoreListingInstalledState,
} from './storeDerivations.js';

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2020-01-01T00:00:00.000Z';

function entry(catalogId: string): CatalogEntry {
  const found = getCatalogEntry(catalogId);
  if (!found) throw new Error(`catalog entry '${catalogId}' missing`);
  return found;
}

function installRow(over: Partial<StoreInstall> = {}): StoreInstall {
  return {
    spaceId: SPACE_ID,
    catalogId: 'github',
    kind: 'connector',
    installedVersion: 1,
    installedContentHash: 'hash',
    state: 'installed',
    installedAt: NOW,
    installedBy: USER_ID,
    updatedAt: NOW,
    updatedBy: USER_ID,
    ...over,
  };
}

const MCP_CONNECTOR = CatalogEntrySchema.parse({
  catalogId: 'kagglemcp',
  kind: 'connector',
  sourceKind: 'mcp',
  version: 1,
  status: 'published',
  name: 'Kaggle MCP',
  tagline: 'Kaggle over MCP.',
  description: 'A vetted Kaggle MCP connector.',
  honestyLabel: 'curated',
  payload: {
    catalogId: 'kagglemcp',
    version: 1,
    name: 'Kaggle MCP',
    tagline: 'Kaggle over MCP.',
    description: 'A vetted Kaggle MCP connector.',
    honestyLabel: 'curated',
    authKind: 'bearer',
    credentialPrompts: [{ authField: 'credentialKey', label: 'Kaggle API token' }],
    definition: {
      serverId: 'kaggle',
      name: 'Kaggle MCP',
      serverUrl: 'https://mcp.kaggle.com/mcp',
    },
  },
});

// ============================================================================
// Installed state
// ============================================================================

describe('deriveInstalledState', () => {
  it('reports not-installed without a row', () => {
    expect(deriveInstalledState({ version: 3 }, null)).toEqual({
      installed: false,
      updateAvailable: false,
    });
  });

  it('reports installed with no update at the same version', () => {
    expect(deriveInstalledState({ version: 1 }, installRow())).toEqual({
      installed: true,
      installedVersion: 1,
      updateAvailable: false,
      state: 'installed',
    });
  });

  it('flags an update when the catalog moved ahead', () => {
    expect(deriveInstalledState({ version: 2 }, installRow()).updateAvailable).toBe(true);
  });

  it('suppresses the update badge while skippedVersion equals the catalog version', () => {
    const state = deriveInstalledState({ version: 2 }, installRow({ skippedVersion: 2 }));
    expect(state.updateAvailable).toBe(false);
  });

  it('re-raises the badge once the catalog moves past a skipped version', () => {
    const state = deriveInstalledState({ version: 3 }, installRow({ skippedVersion: 2 }));
    expect(state.updateAvailable).toBe(true);
  });

  it('surfaces the removing state', () => {
    expect(deriveInstalledState({ version: 1 }, installRow({ state: 'removing' })).state).toBe(
      'removing',
    );
  });
});

// ============================================================================
// List visibility
// ============================================================================

describe('selectListableEntries', () => {
  const published = entry('github');
  const unlisted = entry('test-two-skill-bundle');
  const deprecated = { ...entry('jira-cloud'), status: 'deprecated' } as CatalogEntry;
  const all = [published, unlisted, deprecated];

  const openShelf: TenantStoreShelfPolicy = {
    defaultAvailability: 'available',
    overrides: new Map(),
  };
  const hiddenShelf: TenantStoreShelfPolicy = {
    defaultAvailability: 'hidden',
    overrides: new Map(),
  };

  it('lists published, hides unlisted, hides uninstalled deprecated', () => {
    const listed = selectListableEntries(all, new Set(), openShelf);
    expect(listed.map((e) => e.catalogId)).toEqual(['github']);
  });

  it('lists deprecated entries only for spaces that installed them', () => {
    const listed = selectListableEntries(all, new Set(['jira-cloud']), openShelf);
    expect(listed.map((e) => e.catalogId)).toEqual(['github', 'jira-cloud']);
  });

  it('a hidden default empties the shelf regardless of status', () => {
    expect(selectListableEntries(all, new Set(), hiddenShelf)).toEqual([]);
  });

  it('an available override re-shelves a listing under a hidden default', () => {
    const shelf: TenantStoreShelfPolicy = {
      defaultAvailability: 'hidden',
      overrides: new Map([['github', 'available']]),
    };
    expect(selectListableEntries(all, new Set(), shelf).map((e) => e.catalogId)).toEqual([
      'github',
    ]);
  });

  it('a hidden override removes a published listing under an available default', () => {
    const shelf: TenantStoreShelfPolicy = {
      defaultAvailability: 'available',
      overrides: new Map([['github', 'hidden']]),
    };
    expect(selectListableEntries(all, new Set(), shelf)).toEqual([]);
  });

  it('an installed listing stays listed even when the shelf hides it', () => {
    const listed = selectListableEntries(all, new Set(['github', 'jira-cloud']), hiddenShelf);
    expect(listed.map((e) => e.catalogId)).toEqual(['github', 'jira-cloud']);
  });

  it('status rules still apply to installed-but-hidden listings', () => {
    const listed = selectListableEntries(all, new Set(['test-two-skill-bundle']), hiddenShelf);
    expect(listed).toEqual([]);
  });
});

describe('searchListableEntries', () => {
  const published = entry('github');
  const unlisted = entry('test-two-skill-bundle');
  const deprecated = { ...entry('jira-cloud'), status: 'deprecated' } as CatalogEntry;
  const all = [published, unlisted, deprecated];

  const openShelf: TenantStoreShelfPolicy = {
    defaultAvailability: 'available',
    overrides: new Map(),
  };

  it('finds published entries by keyword', () => {
    const found = searchListableEntries(all, new Set(), openShelf, 'github');
    expect(found.map((e) => e.catalogId)).toContain('github');
  });

  it('resolves an on-shelf unlisted entry only by its exact catalogId', () => {
    const byId = searchListableEntries(all, new Set(), openShelf, 'test-two-skill-bundle');
    expect(byId.map((e) => e.catalogId)).toEqual(['test-two-skill-bundle']);
    const byKeyword = searchListableEntries(all, new Set(), openShelf, 'skill');
    expect(byKeyword.map((e) => e.catalogId)).not.toContain('test-two-skill-bundle');
  });

  it('a shelf-hidden unlisted entry does not resolve even by exact id', () => {
    const shelf: TenantStoreShelfPolicy = {
      defaultAvailability: 'available',
      overrides: new Map([['test-two-skill-bundle', 'hidden']]),
    };
    expect(searchListableEntries(all, new Set(), shelf, 'test-two-skill-bundle')).toEqual([]);
  });

  it('surfaces a deprecated entry only for spaces that installed it', () => {
    expect(searchListableEntries(all, new Set(), openShelf, 'jira')).toEqual([]);
    const installed = searchListableEntries(all, new Set(['jira-cloud']), openShelf, 'jira');
    expect(installed.map((e) => e.catalogId)).toEqual(['jira-cloud']);
  });
});

describe('toStoreListingInstalledState', () => {
  it('maps the three read-surface shapes onto the op enum', () => {
    expect(toStoreListingInstalledState({ installed: false, updateAvailable: false })).toBe(
      'not_installed',
    );
    expect(
      toStoreListingInstalledState({
        installed: true,
        installedVersion: 1,
        updateAvailable: false,
      }),
    ).toBe('installed');
    expect(
      toStoreListingInstalledState({ installed: true, installedVersion: 1, updateAvailable: true }),
    ).toBe('update_available');
  });
});

describe('isListingOnTenantShelf', () => {
  const github = entry('github');

  it('the override wins over the default', () => {
    const shelf: TenantStoreShelfPolicy = {
      defaultAvailability: 'available',
      overrides: new Map([['github', 'hidden']]),
    };
    expect(isListingOnTenantShelf(github, new Set(), shelf)).toBe(false);
  });

  it('an installed listing is always on the shelf', () => {
    const shelf: TenantStoreShelfPolicy = { defaultAvailability: 'hidden', overrides: new Map() };
    expect(isListingOnTenantShelf(github, new Set(['github']), shelf)).toBe(true);
  });
});

// ============================================================================
// Requirements
// ============================================================================

describe('deriveListingRequirements', () => {
  it('a bundle of plain fixture skills needs nothing', () => {
    expect(deriveListingRequirements(entry('test-two-skill-bundle'))).toEqual({
      credentialKeys: [],
      oauthIssuers: [],
      needsRepo: false,
      needsModelKey: false,
    });
  });

  it('a bearer API connector needs its placeholder credential key', () => {
    expect(deriveListingRequirements(entry('github'))).toEqual({
      credentialKeys: ['github-default-token'],
      oauthIssuers: [],
      needsRepo: false,
      needsModelKey: false,
    });
  });

  it('a basic-auth connector needs username + secret keys', () => {
    expect(deriveListingRequirements(entry('jira-cloud')).credentialKeys).toEqual([
      'jira-cloud-default-username',
      'jira-cloud-default-secret',
    ]);
  });

  it('an OAuth connector needs its issuer, not credential keys', () => {
    const github = entry('github');
    if (github.kind !== 'connector' || github.sourceKind !== 'api') throw new Error('unexpected');
    const oauth = {
      ...github,
      payload: {
        ...github.payload,
        authKind: 'oauth2_authorization_code',
        oauthIssuerKey: 'github',
      },
    } as CatalogEntry;
    expect(deriveListingRequirements(oauth)).toEqual({
      credentialKeys: [],
      oauthIssuers: ['github'],
      needsRepo: false,
      needsModelKey: false,
    });
  });

  it('an MCP connector needs its placeholder binding token', () => {
    expect(deriveListingRequirements(MCP_CONNECTOR).credentialKeys).toEqual([
      'kaggle-default-token',
    ]);
  });

  it('a bundle unions member needs with its binding-template credential keys', () => {
    const kaggle = deriveListingRequirements(entry('kaggle-competition'));
    expect(kaggle.credentialKeys).toEqual(['kaggle-api-token']);
    expect(kaggle.needsRepo).toBe(false);

    const coding = deriveListingRequirements(entry('coding-pr-loop'));
    expect(coding.needsRepo).toBe(true);
    expect(coding.needsModelKey).toBe(true);
  });
});

// ============================================================================
// API connector credential slots + checklist
// ============================================================================

describe('deriveApiConnectorCredentialSlots', () => {
  it('derives a labeled token slot for a bearer connector', () => {
    const github = entry('github');
    if (github.kind !== 'connector' || github.sourceKind !== 'api') throw new Error('unexpected');
    expect(deriveApiConnectorCredentialSlots(github.payload)).toEqual([
      {
        authField: 'credentialKey',
        credentialKey: 'github-default-token',
        role: 'token',
        label: 'GitHub token',
      },
    ]);
  });

  it('derives username/password roles for a basic connector', () => {
    const jira = entry('jira-cloud');
    if (jira.kind !== 'connector' || jira.sourceKind !== 'api') throw new Error('unexpected');
    const slots = deriveApiConnectorCredentialSlots(jira.payload);
    expect(slots.map((slot) => slot.role)).toEqual(['username', 'password']);
    expect(slots.map((slot) => slot.credentialKey)).toEqual([
      'jira-cloud-default-username',
      'jira-cloud-default-secret',
    ]);
  });

  it('derives an api_key slot for a query-placement connector (matching the query auth_json)', () => {
    const fred = entry('fred');
    if (fred.kind !== 'connector' || fred.sourceKind !== 'api') throw new Error('unexpected');
    expect(deriveApiConnectorCredentialSlots(fred.payload)).toEqual([
      {
        authField: 'credentialKey',
        credentialKey: 'fred-default-key',
        role: 'api_key',
        label: 'FRED API key',
      },
    ]);
  });
});

describe('deriveApiConnectorSetupChecklist', () => {
  const github = entry('github');
  if (github.kind !== 'connector' || github.sourceKind !== 'api') throw new Error('unexpected');

  it('emits one fill_credentials task scoped to the missing keys', () => {
    const checklist = deriveApiConnectorSetupChecklist(github.payload, ['github-default-token']);
    expect(checklist).toEqual([
      {
        kind: 'fill_credentials',
        bindingId: 'github-default',
        slots: [
          {
            authField: 'credentialKey',
            credentialKey: 'github-default-token',
            role: 'token',
            label: 'GitHub token',
          },
        ],
        description: 'Add credentials for the GitHub integration.',
        required: true,
      },
    ]);
  });

  it('emits nothing when no keys are missing', () => {
    expect(deriveApiConnectorSetupChecklist(github.payload, [])).toEqual([]);
  });
});

// ============================================================================
// Planned artifacts + provenance plan
// ============================================================================

describe('derivePlannedArtifacts', () => {
  it('a connector creates a definition + a default binding', () => {
    expect(derivePlannedArtifacts(entry('github'))).toEqual([
      { artifactType: 'api_definition', artifactKey: 'github' },
      { artifactType: 'api_binding', artifactKey: 'github-default' },
    ]);
  });

  it('a bundle creates member skills plus its api artifacts', () => {
    const planned = derivePlannedArtifacts(entry('kaggle-competition'));
    const byType = new Map<string, string[]>();
    for (const artifact of planned) {
      byType.set(artifact.artifactType, [
        ...(byType.get(artifact.artifactType) ?? []),
        artifact.artifactKey,
      ]);
    }
    expect(byType.get('skill')).toContain('kaggle-competition-optimizer');
    expect(byType.get('api_definition')).toContain('kaggle');
    expect(byType.get('api_binding')?.length).toBeGreaterThan(0);
  });
});

describe('deriveInstallProvenance', () => {
  const actor = { spaceId: SPACE_ID, actorUserId: USER_ID, now: NOW };

  it('a bundle plans member install rows, bundle claims, and member artifacts under both owners', () => {
    const plan = deriveInstallProvenance(entry('test-two-skill-bundle'), actor);
    expect(plan.install.kind).toBe('bundle');
    expect(plan.install).toMatchObject({
      spaceId: SPACE_ID,
      catalogId: 'test-two-skill-bundle',
      installedVersion: 1,
      state: 'installed',
      installedBy: USER_ID,
      updatedBy: USER_ID,
      installedAt: NOW,
      updatedAt: NOW,
    });
    expect(plan.memberInstalls.map((row) => row.catalogId).sort()).toEqual([
      '_test-skill-a',
      '_test-skill-b',
    ]);
    expect(plan.memberInstalls.every((row) => row.kind === 'skill')).toBe(true);
    const memberSkill = getSkillCatalogEntry('_test-skill-a');
    if (!memberSkill) throw new Error('fixture skill missing');
    const memberArtifact = plan.artifacts.find(
      (artifact) =>
        artifact.artifactKey === 'test-skill-a' && artifact.catalogId === '_test-skill-a',
    );
    // The artifact stamp hashes the content as installed (workflow doc,
    // lifecycle-stripped), not the listing envelope — divergence compares
    // it against the space's current doc.
    expect(memberArtifact?.installedContentHash).toBe(skillBundleContentHash(memberSkill.bundle));
    expect(memberArtifact?.preservation).toBe('replace_on_update');
    expect(plan.claims).toEqual([
      { spaceId: SPACE_ID, catalogId: 'test-two-skill-bundle', claimedBy: 'direct' },
      { spaceId: SPACE_ID, catalogId: '_test-skill-a', claimedBy: 'bundle:test-two-skill-bundle' },
      { spaceId: SPACE_ID, catalogId: '_test-skill-b', claimedBy: 'bundle:test-two-skill-bundle' },
    ]);
    const memberArtifactOwners = plan.artifacts
      .filter((artifact) => artifact.artifactKey === 'test-skill-a')
      .map((artifact) => artifact.catalogId)
      .sort();
    expect(memberArtifactOwners).toEqual(['_test-skill-a', 'test-two-skill-bundle']);
  });

  it('captures the listing host manifest on the install row', () => {
    const plan = deriveInstallProvenance(entry('github'), actor);
    expect(plan.install.hostManifest).toEqual(entry('github').hostManifest);
    expect(plan.install.hostManifest?.apiHosts).toContain('api.github.com');
  });

  it('a connector plans a replaceable definition and a user-data-keep binding', () => {
    const plan = deriveInstallProvenance(entry('github'), actor);
    expect(plan.artifacts).toMatchObject([
      { artifactType: 'api_definition', artifactKey: 'github', preservation: 'replace_on_update' },
      {
        artifactType: 'api_binding',
        artifactKey: 'github-default',
        preservation: 'user_data_keep',
      },
    ]);
    const mcpPlan = deriveInstallProvenance(MCP_CONNECTOR, actor);
    expect(mcpPlan.artifacts).toMatchObject([
      { artifactType: 'mcp_definition', artifactKey: 'kaggle', preservation: 'replace_on_update' },
      {
        artifactType: 'mcp_binding',
        artifactKey: 'kaggle-default',
        preservation: 'user_data_keep',
      },
    ]);
  });
});
