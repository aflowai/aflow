import { z } from 'zod';
import { IdempotencyKeySchema } from '../runtime/ids.js';
import { PostInstallTaskSchema } from '../cybernetic/skillBundle.js';
import { CatalogIdSchema } from './catalogEntry.js';
import { StoreArtifactTypeSchema, StoreInstallSchema } from './provenance.js';
import { StoreInstallErrorBodySchema } from './installContracts.js';

/**
 * - `update` — apply the new catalog version; refused when any
 *   replace_on_update artifact diverged from its installed content.
 * - `replace_customized` — apply the new version, discarding local
 *   customizations of replace_on_update artifacts (stated plainly in the UI).
 * - `keep` — keep the installed content; records the skipped catalog version
 *   so the update badge clears until the next version.
 */
export const StoreUpdateModeSchema = z.enum(['update', 'replace_customized', 'keep']);
export type StoreUpdateMode = z.infer<typeof StoreUpdateModeSchema>;

export const StoreUpdateRequestSchema = z.object({
  catalogId: CatalogIdSchema,
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .describe(
      'The catalogVersion returned by update-preview; a mismatch fails with CATALOG_CHANGED — re-preview and retry',
    ),
  idempotencyKey: z
    .string()
    .uuid()
    .pipe(IdempotencyKeySchema)
    .describe('Makes retried and double-submitted updates no-ops'),
  mode: StoreUpdateModeSchema,
});
export type StoreUpdateRequest = z.infer<typeof StoreUpdateRequestSchema>;

export const StoreArtifactDivergenceStateSchema = z.enum(['pristine', 'modified', 'missing']);
export type StoreArtifactDivergenceState = z.infer<typeof StoreArtifactDivergenceStateSchema>;

/** Per-artifact Mine-vs-installed verdict for one replace_on_update artifact. */
export const StoreArtifactDivergenceSchema = z.object({
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z.string().min(1).max(256),
  state: StoreArtifactDivergenceStateSchema,
  /**
   * Pretty-printed canonical JSON of the exact content the hashes cover, for
   * the Mine-vs-Store diff. Present only for `modified` artifacts when both
   * sides fit the payload cap.
   */
  contents: z.object({ mine: z.string(), store: z.string() }).optional(),
  contentsTruncated: z
    .boolean()
    .optional()
    .describe('A modified artifact whose content exceeded the payload cap — diff unavailable'),
});
export type StoreArtifactDivergence = z.infer<typeof StoreArtifactDivergenceSchema>;

/**
 * Recomputed-at-read customization verdict for an installation: each
 * replace_on_update artifact's current content hash compared against the hash
 * stamped at install/update time. user_data_keep artifacts are excluded —
 * they are expected to change.
 */
export const StoreInstallDivergenceSchema = z.object({
  customized: z.boolean(),
  artifacts: z.array(StoreArtifactDivergenceSchema),
});
export type StoreInstallDivergence = z.infer<typeof StoreInstallDivergenceSchema>;

export const StoreUpdatePreviewRequestSchema = z.object({
  catalogId: CatalogIdSchema,
});
export type StoreUpdatePreviewRequest = z.infer<typeof StoreUpdatePreviewRequestSchema>;

export const StoreUpdatePreviewResponseSchema = z.object({
  catalogId: CatalogIdSchema,
  currentVersion: z.number().int().min(1).describe('The installed version'),
  catalogVersion: z.number().int().min(1).describe('Echo as expectedVersion when updating'),
  updateAvailable: z.boolean(),
  skippedVersion: z.number().int().min(1).optional(),
  divergence: StoreInstallDivergenceSchema,
});
export type StoreUpdatePreviewResponse = z.infer<typeof StoreUpdatePreviewResponseSchema>;

export const StoreUpdatedArtifactSchema = z.object({
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z.string().min(1).max(256),
  action: z.enum(['replaced', 'installed']),
});
export type StoreUpdatedArtifact = z.infer<typeof StoreUpdatedArtifactSchema>;

export const StoreUpdateResponseSchema = z.object({
  catalogId: CatalogIdSchema,
  mode: StoreUpdateModeSchema,
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  updatedArtifacts: z.array(StoreUpdatedArtifactSchema),
  keptUserDataArtifacts: z.array(
    z.object({
      artifactType: StoreArtifactTypeSchema,
      artifactKey: z.string().min(1).max(256),
    }),
  ),
  orphanedArtifacts: z
    .array(
      z.object({
        artifactType: StoreArtifactTypeSchema,
        artifactKey: z.string().min(1).max(256),
      }),
    )
    .describe(
      'Artifacts the new version no longer manages — provenance released, the space copies untouched',
    ),
  credentialsReset: z
    .boolean()
    .describe(
      'True when an incompatible auth shape placeholder-reset credential slots; the setupChecklist carries the reappeared rows',
    ),
  missingVariables: z.array(z.string()),
  setupChecklist: z.array(PostInstallTaskSchema),
  install: StoreInstallSchema,
});
export type StoreUpdateResponse = z.infer<typeof StoreUpdateResponseSchema>;

export const StoreCustomizedErrorSchema = z.object({
  error: z.string(),
  code: z.literal('STORE_CUSTOMIZED'),
  catalogId: CatalogIdSchema,
  divergence: StoreInstallDivergenceSchema,
});
export type StoreCustomizedError = z.infer<typeof StoreCustomizedErrorSchema>;

export const StoreUpdateErrorBodySchema = StoreInstallErrorBodySchema.extend({
  divergence: StoreInstallDivergenceSchema.optional(),
});
export type StoreUpdateErrorBody = z.infer<typeof StoreUpdateErrorBodySchema>;
