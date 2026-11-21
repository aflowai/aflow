/**
 * store.listing.* inline handlers: shelf-composed search visibility with
 * per-space install state, full-entry get, install and update. Under the
 * space's autonomy `full` install and update run the shared executions the
 * Store's routes run. Under `ratify` install only writes a `store_install`
 * StagedChange doc, and the shared install execution is never reached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, StepDefinition, StoreInstall } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import {
  StagedChangeSchema,
  StoreListingGetOutputSchema,
  StoreListingInstallOutputSchema,
  StoreListingSearchOutputSchema,
} from '@aflow/schemas';

const mockAddStepResult = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  shelfDefault: 'available' as 'available' | 'hidden',
  shelfOverrides: [] as Array<[string, 'available' | 'hidden']>,
}));
const mockDocPut = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnsureParentDirs = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...orig,
    getDatabase: () => ({}) as never,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: never) => Promise<unknown>) =>
      fn({} as never),
    getTenantStoreShelfPolicy: async () => ({
      defaultAvailability: dbState.shelfDefault,
      overrides: new Map(dbState.shelfOverrides),
    }),
    createMemoryDocRepository: () => ({ put: (...a: unknown[]) => mockDocPut(...(a as [])) }),
    createMemoryDirRepository: () => ({
      ensureParentDirs: (...a: unknown[]) => mockEnsureParentDirs(...(a as [])),
    }),
  };
});

const catalogFixture = vi.hoisted(() => ({
  entries: [] as Array<{ catalogId: string; kind: string }>,
}));
vi.mock('@aflow/platform-artifacts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/platform-artifacts')>();
  return {
    ...orig,
    listCatalog: (filter?: { kind?: string }) =>
      catalogFixture.entries.filter(
        (entry) => filter?.kind === undefined || entry.kind === filter.kind,
      ),
    getCatalogEntry: (catalogId: string) =>
      catalogFixture.entries.find((entry) => entry.catalogId === catalogId) ?? null,
  };
});

const provenance = vi.hoisted(() => ({ installs: [] as Array<{ catalogId: string }> }));
const mockExecuteStoreInstall = vi.hoisted(() => vi.fn());
const mockUpsertStoreInstall = vi.hoisted(() => vi.fn());
const mockExecuteStoreUpdate = vi.hoisted(() => vi.fn());
const autonomyState = vi.hoisted(() => ({ autonomy: 'full' as 'full' | 'ratify' }));
vi.mock('../sessionUser.js', () => ({
  sessionUser: async () => '00000000-0000-4000-8000-0000000000aa',
}));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...orig,
    executeStoreInstall: mockExecuteStoreInstall,
    executeStoreUpdate: mockExecuteStoreUpdate,
    readSpaceAutonomyPolicy: async () => ({
      autonomy: autonomyState.autonomy,
      storeUpdates: 'follow-catalog',
    }),
    readSpaceOwnerUserId: async () => null,
    upsertStoreInstall: mockUpsertStoreInstall,
    listStoreInstalls: async () => provenance.installs,
    getStoreInstall: async (_tx: unknown, _spaceId: string, catalogId: string) =>
      provenance.installs.find((install) => install.catalogId === catalogId) ?? null,
  };
});

const actualCatalog = await vi.importActual<typeof import('@aflow/platform-artifacts')>(
  '@aflow/platform-artifacts',
);

function realEntry(catalogId: string): CatalogEntry {
  const found = actualCatalog.getCatalogEntry(catalogId);
  if (!found) throw new Error(`fixture entry '${catalogId}' missing from the catalog`);
  return found;
}

const GITHUB = realEntry('github');
const TEST_BUNDLE_UNLISTED = realEntry('test-two-skill-bundle');
const JIRA_DEPRECATED = { ...realEntry('jira-cloud'), status: 'deprecated' } as CatalogEntry;

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const NOW = '2020-01-01T00:00:00.000Z';

function installRow(catalogId: string, installedVersion: number): StoreInstall {
  return {
    spaceId: SPACE,
    catalogId,
    kind: 'connector',
    installedVersion,
    installedContentHash: 'hash',
    state: 'installed',
    installedAt: NOW,
    installedBy: USER,
    updatedAt: NOW,
    updatedBy: USER,
  };
}

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeRef(ref: string): unknown {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

function makeArgs(operation: string, resolvedInput: unknown) {
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      traceId: 'trace-1',
      agentDefinition: { steps: [] } as never,
    },
    stepDef: {
      stepId: 'step-1',
      stepType: 'store',
      operation,
      tags: [],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
    stepExecutionId: 'step-exec-1',
    idempotencyKey: 'idempotent-1' as never,
    resolvedInputRef: inlineRef(resolvedInput),
    attempt: 1,
    scheduledAtMs: Date.now(),
  } as never;
}

function lastStepResult(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

function succeededOutput(): unknown {
  const result = lastStepResult();
  expect(result['status']).toBe('SUCCEEDED');
  return decodeRef(result['outputRef'] as string);
}

function failedError(): Record<string, unknown> {
  const result = lastStepResult();
  expect(result['status']).toBe('FAILED');
  return result['error'] as Record<string, unknown>;
}

const {
  handleStoreListingSearchInline,
  handleStoreListingGetInline,
  handleStoreListingInstallInline,
  handleStoreListingUpdateInline,
} = await import('../storeListing.js');

beforeEach(() => {
  vi.clearAllMocks();
  dbState.shelfDefault = 'available';
  dbState.shelfOverrides = [];
  catalogFixture.entries = [GITHUB, TEST_BUNDLE_UNLISTED, JIRA_DEPRECATED] as never;
  provenance.installs = [];
  autonomyState.autonomy = 'full';
});

describe('store.listing.search', () => {
  it('browse lists published on-shelf entries as payload-free summaries with install state', async () => {
    await handleStoreListingSearchInline(makeArgs('store.listing.search', {}));

    const output = StoreListingSearchOutputSchema.parse(succeededOutput());
    expect(output.listings.map((l) => l.catalogId)).toEqual(['github']);
    expect(output.listings[0]?.installedState).toBe('not_installed');
    expect(output.listings[0]).not.toHaveProperty('payload');
    expect(output.listings[0]?.requirements.credentialKeys).toContain('github-default-token');
  });

  it('includes a deprecated entry only when installed, with installed state derived per space', async () => {
    provenance.installs = [installRow('jira-cloud', JIRA_DEPRECATED.version)];
    await handleStoreListingSearchInline(makeArgs('store.listing.search', {}));

    const output = StoreListingSearchOutputSchema.parse(succeededOutput());
    const byId = new Map(output.listings.map((l) => [l.catalogId, l]));
    expect([...byId.keys()].sort()).toEqual(['github', 'jira-cloud']);
    expect(byId.get('jira-cloud')?.installedState).toBe('installed');
  });

  it('reports update_available when the catalog moved past the installed version', async () => {
    catalogFixture.entries = [{ ...GITHUB, version: GITHUB.version + 1 }] as never;
    provenance.installs = [installRow('github', GITHUB.version)];
    await handleStoreListingSearchInline(makeArgs('store.listing.search', {}));

    const output = StoreListingSearchOutputSchema.parse(succeededOutput());
    expect(output.listings[0]?.installedState).toBe('update_available');
  });

  it('omits shelf-hidden listings entirely', async () => {
    dbState.shelfOverrides = [['github', 'hidden']];
    catalogFixture.entries = [GITHUB] as never;
    await handleStoreListingSearchInline(makeArgs('store.listing.search', {}));

    const output = StoreListingSearchOutputSchema.parse(succeededOutput());
    expect(output.listings).toEqual([]);
  });

  it('query search resolves an unlisted entry by exact catalogId but not by keyword', async () => {
    await handleStoreListingSearchInline(
      makeArgs('store.listing.search', { query: 'test-two-skill-bundle' }),
    );
    const output = StoreListingSearchOutputSchema.parse(succeededOutput());
    expect(output.listings.map((l) => l.catalogId)).toEqual(['test-two-skill-bundle']);
  });
});

describe('store.listing.get', () => {
  it('returns the full entry with install state and requirements', async () => {
    await handleStoreListingGetInline(makeArgs('store.listing.get', { catalogId: 'github' }));

    const output = StoreListingGetOutputSchema.parse(succeededOutput());
    expect(output.listing.catalogId).toBe('github');
    expect(output.listing.payload).toBeDefined();
    expect(output.installedState).toBe('not_installed');
  });

  it('teaches not-found for an unknown catalogId', async () => {
    await handleStoreListingGetInline(makeArgs('store.listing.get', { catalogId: 'nope' }));
    expect(failedError()['code']).toBe('STORE_LISTING_NOT_FOUND');
  });

  it('a shelf-hidden listing reads as not-found unless installed', async () => {
    dbState.shelfOverrides = [['github', 'hidden']];
    await handleStoreListingGetInline(makeArgs('store.listing.get', { catalogId: 'github' }));
    expect(failedError()['code']).toBe('STORE_LISTING_NOT_FOUND');

    mockAddStepResult.mockClear();
    provenance.installs = [installRow('github', GITHUB.version)];
    await handleStoreListingGetInline(makeArgs('store.listing.get', { catalogId: 'github' }));
    const output = StoreListingGetOutputSchema.parse(succeededOutput());
    expect(output.installedState).toBe('installed');
  });
});

describe('store.listing.install', () => {
  const validInput = { catalogId: 'github', expectedVersion: GITHUB.version };

  it('under ratify, writes a store_install StagedChange proposal and returns its id — no install executes', async () => {
    autonomyState.autonomy = 'ratify';
    await handleStoreListingInstallInline(makeArgs('store.listing.install', validInput));

    const output = StoreListingInstallOutputSchema.parse(succeededOutput());
    if (output.status !== 'proposed') throw new Error('expected a proposal');
    expect(output.catalogId).toBe('github');

    expect(mockDocPut).toHaveBeenCalledTimes(1);
    const doc = mockDocPut.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(doc['path']).toBe(`/coach/staged/${output.proposalId}.json`);
    expect(doc['semanticType']).toBe('staged_change');
    expect(doc['tags']).toEqual(['coach', 'staged', 'store_install']);

    const stagedChange = StagedChangeSchema.parse(JSON.parse(doc['inlineContent'] as string));
    expect(stagedChange.id).toBe(output.proposalId);
    expect(stagedChange.kind).toBe('store_install');
    expect(stagedChange.status).toBe('proposed');
    expect(stagedChange.authorityLevel).toBe('require_operator');
    expect(stagedChange.proposal.ops).toEqual([
      {
        op: 'store_install',
        catalogId: 'github',
        expectedVersion: GITHUB.version,
        listing: {
          name: GITHUB.name,
          kind: 'connector',
          tagline: GITHUB.tagline,
          requirements: {
            credentialKeys: ['github-default-token'],
            oauthIssuers: [],
            needsRepo: false,
            needsModelKey: false,
          },
        },
      },
    ]);

    expect(mockExecuteStoreInstall).not.toHaveBeenCalled();
    expect(mockUpsertStoreInstall).not.toHaveBeenCalled();
  });

  it('rejects a deprecated listing with a teaching error and writes nothing', async () => {
    await handleStoreListingInstallInline(
      makeArgs('store.listing.install', {
        catalogId: 'jira-cloud',
        expectedVersion: JIRA_DEPRECATED.version,
      }),
    );
    expect(failedError()['code']).toBe('STORE_LISTING_NOT_INSTALLABLE');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('rejects an expectedVersion behind the catalog with re-read guidance', async () => {
    await handleStoreListingInstallInline(
      makeArgs('store.listing.install', {
        catalogId: 'github',
        expectedVersion: GITHUB.version + 5,
      }),
    );
    const error = failedError();
    expect(error['code']).toBe('STORE_LISTING_VERSION_CHANGED');
    expect(error['message']).toContain('store.listing.get');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('rejects an already-installed listing', async () => {
    provenance.installs = [installRow('github', GITHUB.version)];
    await handleStoreListingInstallInline(makeArgs('store.listing.install', validInput));
    expect(failedError()['code']).toBe('STORE_LISTING_ALREADY_INSTALLED');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('a shelf-hidden listing reads as not-found', async () => {
    dbState.shelfOverrides = [['github', 'hidden']];
    await handleStoreListingInstallInline(makeArgs('store.listing.install', validInput));
    expect(failedError()['code']).toBe('STORE_LISTING_NOT_FOUND');
    expect(mockDocPut).not.toHaveBeenCalled();
  });
});

describe('store.listing.install under the space autonomy full', () => {
  const validInput = { catalogId: 'github', expectedVersion: GITHUB.version };

  it('installs through the shared execution and returns the setup checklist — no proposal is written', async () => {
    mockExecuteStoreInstall.mockResolvedValueOnce({ ok: true, response: { setupChecklist: [] } });
    await handleStoreListingInstallInline(makeArgs('store.listing.install', validInput));

    const output = StoreListingInstallOutputSchema.safeParse(succeededOutput());
    expect(mockExecuteStoreInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        spaceId: SPACE,
        actorUserId: USER,
        catalogId: 'github',
        expectedVersion: GITHUB.version,
        idempotencyKey: 'idempotent-1',
      }),
    );
    expect(mockDocPut).not.toHaveBeenCalled();
    expect(output.success ? output.data : undefined).toEqual({
      status: 'installed',
      catalogId: 'github',
      installedVersion: GITHUB.version,
      setupChecklist: [],
    });
  });

  it('names a refused install with the execution’s words', async () => {
    mockExecuteStoreInstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: { error: 'Listing changed', code: 'CATALOG_CHANGED' },
    });
    await handleStoreListingInstallInline(makeArgs('store.listing.install', validInput));
    const error = failedError();
    expect(error['code']).toBe('CATALOG_CHANGED');
    expect(error['message']).toContain('Listing changed');
  });
});

describe('store.listing.update', () => {
  const response = {
    catalogId: 'github',
    mode: 'update',
    fromVersion: 1,
    toVersion: 2,
    updatedArtifacts: [
      { artifactType: 'skill', artifactKey: 'daily-trading-cycle', action: 'replaced' },
      { artifactType: 'api_definition', artifactKey: 'github', action: 'replaced' },
    ],
    keptUserDataArtifacts: [],
    orphanedArtifacts: [{ artifactType: 'skill', artifactKey: 'old-skill' }],
    credentialsReset: false,
    missingVariables: [],
    setupChecklist: [],
  };

  it('applies the update on the Store route’s path and names the skills to reconcile', async () => {
    mockExecuteStoreUpdate.mockResolvedValueOnce({ ok: true, response });
    await handleStoreListingUpdateInline(
      makeArgs('store.listing.update', { catalogId: 'github', expectedVersion: 2 }),
    );
    expect(mockExecuteStoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'github',
        expectedVersion: 2,
        mode: 'update',
        actorUserId: USER,
      }),
    );
    expect(succeededOutput()).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      reconcile: ['daily-trading-cycle', 'old-skill'],
    });
  });

  it('teaches the two modes where the space customized what the update replaces', async () => {
    mockExecuteStoreUpdate.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: { error: 'Customized', code: 'STORE_CUSTOMIZED' },
    });
    await handleStoreListingUpdateInline(
      makeArgs('store.listing.update', { catalogId: 'github', expectedVersion: 2 }),
    );
    const error = failedError();
    expect(error['code']).toBe('STORE_CUSTOMIZED');
    expect(error['message']).toContain('replace_customized');
  });
});
