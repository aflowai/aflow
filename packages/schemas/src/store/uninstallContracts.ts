import { z } from 'zod';
import { IdempotencyKeySchema } from '../runtime/ids.js';
import { CatalogIdSchema } from './catalogEntry.js';
import { StoreArtifactTypeSchema, StoreInstallKindSchema } from './provenance.js';
import { StoreInstallErrorBodySchema } from './installContracts.js';

export const StoreUninstallRequestSchema = z.object({
  catalogId: CatalogIdSchema,
  idempotencyKey: z
    .string()
    .uuid()
    .pipe(IdempotencyKeySchema)
    .describe('Makes retried and double-submitted uninstalls no-ops'),
  keepUserData: z
    .array(z.string().min(1).max(256))
    .max(200)
    .optional()
    .describe(
      'Artifact keys of user-data artifacts to keep. Omitted keeps every user-data artifact; ' +
        'when present, a pristine user-data artifact whose key is absent is removed. ' +
        'A modified user-data artifact is always kept.',
    ),
});
export type StoreUninstallRequest = z.infer<typeof StoreUninstallRequestSchema>;

export const StoreUninstallPreviewRequestSchema = z.object({
  catalogId: CatalogIdSchema,
});
export type StoreUninstallPreviewRequest = z.infer<typeof StoreUninstallPreviewRequestSchema>;

/**
 * - `archive` — skill: archived via the reversible skill lifecycle, never purged.
 * - `delete` — hard-removed (integration with no dependents, or an
 *   explicitly-unchecked pristine user-data artifact).
 * - `disable` — integration turned off but kept: something still references it
 *   (`dependentSkills` / `dependentRepoCount` name why).
 * - `keep` — user-data artifact kept (default, explicitly kept, or modified).
 * - `missing` — the artifact is already gone from the space.
 */
export const StoreUninstallArtifactActionSchema = z.enum([
  'archive',
  'delete',
  'disable',
  'keep',
  'missing',
]);
export type StoreUninstallArtifactAction = z.infer<typeof StoreUninstallArtifactActionSchema>;

export const StoreUninstallArtifactPlanSchema = z.object({
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z.string().min(1).max(256),
  action: StoreUninstallArtifactActionSchema,
  dependentSkills: z
    .array(z.string().min(1).max(256))
    .optional()
    .describe('Skills still referencing this integration — they block its deletion'),
  dependentRepoCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Coding repositories resolving through this integration'),
  activeRunCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Active workflow runs on this skill; a nonzero count blocks the uninstall'),
  activeInstanceCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Active applet instances pinned to this artifact — the uninstall archives them'),
  userDataRemovable: z
    .boolean()
    .optional()
    .describe('Pristine user-data artifact — omitting it from keepUserData removes it'),
});
export type StoreUninstallArtifactPlan = z.infer<typeof StoreUninstallArtifactPlanSchema>;

export const StoreUninstallMemberPlanSchema = z.object({
  catalogId: CatalogIdSchema,
  action: z.enum(['remove', 'stays']),
  remainingClaims: z
    .array(z.string().min(1).max(160))
    .describe('Claimants that keep the member installed after this uninstall'),
});
export type StoreUninstallMemberPlan = z.infer<typeof StoreUninstallMemberPlanSchema>;

export const StoreUninstallPlanSchema = z.object({
  catalogId: CatalogIdSchema,
  // Uninstall is provenance-driven, so pre-cleanup 'skill' rows stay removable.
  kind: StoreInstallKindSchema,
  installedVersion: z.number().int().min(1),
  action: z
    .enum(['remove', 'release_claim'])
    .describe(
      "'remove' tears the installation down; 'release_claim' only drops the direct claim " +
        'because other claimants keep it installed',
    ),
  remainingClaims: z
    .array(z.string().min(1).max(160))
    .describe('Claimants that keep this entry installed after the uninstall'),
  members: z.array(StoreUninstallMemberPlanSchema),
  artifacts: z.array(StoreUninstallArtifactPlanSchema),
});
export type StoreUninstallPlan = z.infer<typeof StoreUninstallPlanSchema>;

export const StoreUninstallPreviewResponseSchema = StoreUninstallPlanSchema;
export type StoreUninstallPreviewResponse = z.infer<typeof StoreUninstallPreviewResponseSchema>;

/** The executed plan — identical shape to the preview by construction. */
export const StoreUninstallResponseSchema = StoreUninstallPlanSchema;
export type StoreUninstallResponse = z.infer<typeof StoreUninstallResponseSchema>;

export const StoreUninstallErrorBodySchema = StoreInstallErrorBodySchema.extend({
  skillId: z.string().optional(),
  runIds: z.array(z.string()).optional(),
});
export type StoreUninstallErrorBody = z.infer<typeof StoreUninstallErrorBodySchema>;
