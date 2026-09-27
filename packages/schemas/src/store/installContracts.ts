import { z } from 'zod';
import { IdempotencyKeySchema } from '../runtime/ids.js';
import { PostInstallTaskSchema } from '../cybernetic/skillBundle.js';
import { IntegrationSourceKindSchema } from '../integrations/index.js';
import { CatalogIdSchema } from './catalogEntry.js';
import { StoreArtifactTypeSchema, StoreInstallSchema } from './provenance.js';

export const StoreInstallRequestSchema = z.object({
  catalogId: CatalogIdSchema,
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .describe(
      'The catalogVersion returned by install-preview; a mismatch fails with CATALOG_CHANGED — re-preview and retry',
    ),
  idempotencyKey: z
    .string()
    .uuid()
    .pipe(IdempotencyKeySchema)
    .describe('Makes retried and double-submitted installs no-ops'),
});
export type StoreInstallRequest = z.infer<typeof StoreInstallRequestSchema>;

export const StoreInstallPreviewRequestSchema = z.object({
  catalogId: CatalogIdSchema,
});
export type StoreInstallPreviewRequest = z.infer<typeof StoreInstallPreviewRequestSchema>;

export const StorePlannedArtifactSchema = z.object({
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z.string().min(1).max(256),
  name: z.string().min(1).max(256).optional(),
});
export type StorePlannedArtifact = z.infer<typeof StorePlannedArtifactSchema>;

export const StoreInstallConflictSchema = z.object({
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z.string().min(1).max(256),
  reason: z.string().min(1).max(500),
});
export type StoreInstallConflict = z.infer<typeof StoreInstallConflictSchema>;

export const StoreInstallPreviewResponseSchema = z.object({
  catalogId: CatalogIdSchema,
  catalogVersion: z.number().int().min(1).describe('Echo as expectedVersion when installing'),
  creates: z.array(StorePlannedArtifactSchema),
  conflicts: z.array(StoreInstallConflictSchema),
  missingCapabilities: z.array(z.string().min(1).max(256)),
});
export type StoreInstallPreviewResponse = z.infer<typeof StoreInstallPreviewResponseSchema>;

export const StoreInstallResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bundle'),
    installedSkillCatalogIds: z.array(z.string()),
    skippedSkillCatalogIds: z.array(z.string()),
    installedApiDefinitionIds: z.array(z.string()),
    skippedApiDefinitionIds: z.array(z.string()),
    installedBindingIds: z.array(z.string()),
    skippedBindingIds: z.array(z.string()),
    installedMcpDefinitionIds: z.array(z.string()),
    skippedMcpDefinitionIds: z.array(z.string()),
    installedMcpBindingIds: z.array(z.string()),
    skippedMcpBindingIds: z.array(z.string()),
    installedMemoryDocPaths: z.array(z.string()),
    skippedMemoryDocPaths: z.array(z.string()),
    installedArtifactBindings: z.array(z.string()),
    skippedArtifactBindings: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('connector'),
    sourceKind: IntegrationSourceKindSchema,
    integrationId: z
      .string()
      .min(1)
      .max(128)
      .describe("apiId when sourceKind is 'api'; serverId when sourceKind is 'mcp'"),
    bindingId: z.string().min(1).max(128),
    status: z.enum(['definition-only', 'needs_credentials', 'needs_oauth_consent']),
    missingVariables: z.array(z.string()),
    missingCredentialKeys: z.array(z.string()),
    consentPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal('applet'),
    artifactId: z.string().uuid().describe('ui_artifacts head row installed for this listing'),
    artifactVersion: z.number().int().min(1),
    bundleArtifactKey: z.string().min(1).max(256),
    outcome: z.enum(['inserted_new', 'inserted_new_version', 'skipped_unchanged']),
  }),
]);
export type StoreInstallResult = z.infer<typeof StoreInstallResultSchema>;

export const StoreInstallResponseSchema = z.object({
  result: StoreInstallResultSchema,
  setupChecklist: z.array(PostInstallTaskSchema),
  install: StoreInstallSchema,
});
export type StoreInstallResponse = z.infer<typeof StoreInstallResponseSchema>;

export const StoreCatalogChangedErrorSchema = z.object({
  error: z.string(),
  code: z.literal('CATALOG_CHANGED'),
  catalogId: CatalogIdSchema,
  expectedVersion: z.number().int().min(1),
  currentVersion: z.number().int().min(1),
});
export type StoreCatalogChangedError = z.infer<typeof StoreCatalogChangedErrorSchema>;

/**
 * Every non-success outcome of a store install, as the execution core reports
 * it. `code` distinguishes the retriable/permanent cases; the per-code extras
 * (version pair, conflicting key, bundle diagnostics) are optional fields on
 * one body so HTTP surfaces and ratification surfaces read the same shape.
 */
export const StoreInstallErrorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  catalogId: z.string().optional(),
  expectedVersion: z.number().optional(),
  currentVersion: z.number().optional(),
  catalogVersion: z.number().optional(),
  conflictingKey: z.string().optional(),
  bundleId: z.string().optional(),
  skillCatalogId: z.string().optional(),
  presentArtifacts: z.array(z.string()).optional(),
  missingArtifacts: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
});
export type StoreInstallErrorBody = z.infer<typeof StoreInstallErrorBodySchema>;
