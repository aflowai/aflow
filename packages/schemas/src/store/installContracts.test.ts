import { describe, it, expect } from 'vitest';
import {
  StoreInstallRequestSchema,
  StoreInstallPreviewResponseSchema,
  StoreInstallResponseSchema,
  StoreCatalogChangedErrorSchema,
  StoreSpaceInstallRequestSchema,
} from './installContracts.js';

const SPACE_ID = '11111111-2222-4333-8444-555555555555';
const IDEMPOTENCY_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('StoreInstallRequestSchema', () => {
  it('parses a valid request', () => {
    const parsed = StoreInstallRequestSchema.parse({
      catalogId: 'github',
      expectedVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(parsed.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  it('rejects a missing idempotencyKey', () => {
    const result = StoreInstallRequestSchema.safeParse({
      catalogId: 'github',
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid idempotencyKey', () => {
    const result = StoreInstallRequestSchema.safeParse({
      catalogId: 'github',
      expectedVersion: 2,
      idempotencyKey: 'retry-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer expectedVersion', () => {
    const result = StoreInstallRequestSchema.safeParse({
      catalogId: 'github',
      expectedVersion: 1.5,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result.success).toBe(false);
  });
});

describe('StoreInstallPreviewResponseSchema', () => {
  it('parses a preview with conflicts and missing capabilities', () => {
    const result = StoreInstallPreviewResponseSchema.safeParse({
      kind: 'bundle',
      catalogId: 'my-bundle',
      catalogVersion: 3,
      creates: [
        { artifactType: 'skill', artifactKey: 'csv-analyzer', name: 'CSV Analyzer' },
        { artifactType: 'api_definition', artifactKey: 'exampleapi' },
      ],
      conflicts: [
        {
          artifactType: 'skill',
          artifactKey: 'csv-analyzer',
          reason: 'A skill with this slug exists',
        },
      ],
      missingCapabilities: ['api:exampleapi'],
    });
    expect(result.success).toBe(true);
  });

  it('parses a space preview naming the new space, its bundles and its readiness list as it reads', () => {
    const result = StoreInstallPreviewResponseSchema.safeParse({
      kind: 'space',
      catalogId: 'a-quick-start',
      catalogVersion: 1,
      creates: [{ artifactType: 'skill', artifactKey: 'review-local-changes' }],
      conflicts: [],
      missingCapabilities: [],
      space: {
        spaceName: 'Code Review',
        bundles: [{ catalogId: 'local-code-review', catalogVersion: 4 }],
        readiness: [
          {
            key: 'pair-machine',
            title: 'Pair',
            required: true,
            state: 'needs_setup',
            page: '/computer',
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a preview that names no kind', () => {
    const result = StoreInstallPreviewResponseSchema.safeParse({
      catalogId: 'my-bundle',
      catalogVersion: 3,
      creates: [],
      conflicts: [],
      missingCapabilities: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('StoreSpaceInstallRequestSchema', () => {
  it('names the space the install creates', () => {
    const parsed = StoreSpaceInstallRequestSchema.parse({
      catalogId: 'a-quick-start',
      expectedVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      name: 'Code Review',
      slug: 'code-review',
    });
    expect(parsed.slug).toBe('code-review');
    expect(
      StoreSpaceInstallRequestSchema.safeParse({
        catalogId: 'a-quick-start',
        expectedVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);
  });
});

describe('StoreInstallResponseSchema', () => {
  const installedAt = new Date().toISOString();
  const install = {
    spaceId: SPACE_ID,
    catalogId: 'github',
    kind: 'connector' as const,
    installedVersion: 1,
    installedContentHash: 'abc123',
    state: 'installed' as const,
    installedAt,
    installedBy: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    updatedAt: installedAt,
    updatedBy: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  };

  it('parses a connector install response with a setup checklist', () => {
    const result = StoreInstallResponseSchema.safeParse({
      result: {
        kind: 'connector',
        sourceKind: 'api',
        integrationId: 'github',
        bindingId: 'github-default',
        status: 'needs_credentials',
        missingVariables: [],
        missingCredentialKeys: ['github-pat'],
      },
      setupChecklist: [
        {
          kind: 'fill_credentials',
          bindingId: 'github-default',
          slots: [
            {
              authField: 'credentialKey',
              credentialKey: 'github-pat',
              role: 'token',
              label: 'GitHub PAT',
            },
          ],
          description: 'Connect your GitHub account',
          required: true,
        },
      ],
      install,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a result of kind 'skill' — skills install only as bundle members", () => {
    const result = StoreInstallResponseSchema.safeParse({
      result: {
        kind: 'skill',
        skillId: 'csv-analyzer',
        activationStatus: 'active',
        missingCapabilities: [],
      },
      setupChecklist: [],
      install: { ...install, catalogId: 'csv-analyzer', kind: 'skill' },
    });
    expect(result.success).toBe(false);
  });

  it('parses a space install: the new space owns the row, and the template version is on it', () => {
    const bundleResult = {
      kind: 'bundle',
      installedSkillCatalogIds: ['review-local-changes'],
      skippedSkillCatalogIds: [],
      installedApiDefinitionIds: [],
      skippedApiDefinitionIds: [],
      installedBindingIds: [],
      skippedBindingIds: [],
      installedMcpDefinitionIds: [],
      skippedMcpDefinitionIds: [],
      installedMcpBindingIds: [],
      skippedMcpBindingIds: [],
      installedMemoryDocPaths: [],
      skippedMemoryDocPaths: [],
      installedArtifactBindings: [],
      skippedArtifactBindings: [],
      warnings: [],
    };
    const result = StoreInstallResponseSchema.safeParse({
      result: {
        kind: 'space',
        spaceId: SPACE_ID,
        spaceSlug: 'code-review',
        templateVersion: 1,
        bundles: [{ catalogId: 'local-code-review', result: bundleResult }],
        installedAgentSlugs: [],
        installedApiDefinitionIds: [],
        readiness: [
          {
            key: 'pair-machine',
            title: 'Pair',
            required: true,
            state: 'needs_setup',
            page: '/computer',
          },
        ],
      },
      setupChecklist: [],
      install: { ...install, catalogId: 'a-quick-start', kind: 'space' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a result whose kind is not a catalog kind', () => {
    const result = StoreInstallResponseSchema.safeParse({
      result: { kind: 'memory_pack' },
      setupChecklist: [],
      install,
    });
    expect(result.success).toBe(false);
  });
});

describe('StoreCatalogChangedErrorSchema', () => {
  it('parses the version-conflict discriminant', () => {
    const parsed = StoreCatalogChangedErrorSchema.parse({
      error: 'Catalog entry changed between preview and install',
      code: 'CATALOG_CHANGED',
      catalogId: 'github',
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(parsed.code).toBe('CATALOG_CHANGED');
  });

  it('rejects a mislabeled code', () => {
    const result = StoreCatalogChangedErrorSchema.safeParse({
      error: 'nope',
      code: 'VERSION_CONFLICT',
      catalogId: 'github',
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(result.success).toBe(false);
  });
});
