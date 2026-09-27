import { z } from 'zod';
import { CatalogIdSchema, HostManifestSchema } from './catalogEntry.js';

const ContentHashSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Canonical content hash of the entry as installed');

export const StoreInstallStateSchema = z.enum(['installed', 'removing']);
export type StoreInstallState = z.infer<typeof StoreInstallStateSchema>;

/**
 * Wider than the listing kinds: bundle member skills carry their own install
 * rows (`kind: 'skill'`) so claims can tell what a bundle owns from what it
 * shares, even though skills are never standalone listings.
 */
export const StoreInstallKindSchema = z.enum(['skill', 'bundle', 'connector', 'applet']);
export type StoreInstallKind = z.infer<typeof StoreInstallKindSchema>;

/** One active installation of a catalog entry in a space. */
export const StoreInstallSchema = z.object({
  spaceId: z.string().uuid(),
  catalogId: CatalogIdSchema,
  kind: StoreInstallKindSchema,
  installedVersion: z.number().int().min(1),
  installedContentHash: ContentHashSchema,
  skippedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Set by "Keep mine"; suppresses the update badge while it equals the catalog version',
    ),
  state: StoreInstallStateSchema,
  hostManifest: HostManifestSchema.optional().describe(
    'The listing-declared outbound surface captured at install — the vetted egress grant ' +
      'consulted by the tenant integration allowlist',
  ),
  installedAt: z.string().datetime(),
  installedBy: z.string().uuid(),
  updatedAt: z.string().datetime().describe('Initialized to installedAt on the first install'),
  updatedBy: z.string().uuid(),
});
export type StoreInstall = z.infer<typeof StoreInstallSchema>;

export const StoreArtifactTypeSchema = z.enum([
  'skill',
  'api_definition',
  'api_binding',
  'mcp_definition',
  'mcp_binding',
  'memory_doc',
  'ui_artifact',
]);
export type StoreArtifactType = z.infer<typeof StoreArtifactTypeSchema>;

/**
 * - `replace_on_update` — definitional content; update replaces it.
 * - `user_data_keep` — may hold user data by now; update never replaces it,
 *   uninstall defaults to keeping it.
 */
export const StoreArtifactPreservationSchema = z.enum(['replace_on_update', 'user_data_keep']);
export type StoreArtifactPreservation = z.infer<typeof StoreArtifactPreservationSchema>;

/** One artifact an installation wrote — the queryable inventory for update and uninstall. */
export const StoreInstallArtifactSchema = z.object({
  spaceId: z.string().uuid(),
  catalogId: CatalogIdSchema,
  artifactType: StoreArtifactTypeSchema,
  artifactKey: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'Kind-native stable key: workflow slug, apiId, bindingId, memory path, or bundle artifact key',
    ),
  artifactId: z.string().min(1).max(256),
  installedContentHash: ContentHashSchema,
  preservation: StoreArtifactPreservationSchema,
});
export type StoreInstallArtifact = z.infer<typeof StoreInstallArtifactSchema>;

const BUNDLE_CLAIM_PREFIX = 'bundle:';

export const StoreInstallClaimantSchema = z.union([
  z.literal('direct'),
  z
    .string()
    .regex(/^bundle:[a-z0-9_-]+$/, "Must be 'direct' or 'bundle:<bundle catalogId>'")
    .max(BUNDLE_CLAIM_PREFIX.length + 128),
]);
export type StoreInstallClaimant = z.infer<typeof StoreInstallClaimantSchema>;

/**
 * One claim on an installation. A directly installed entry that is also a
 * member of installed bundles carries multiple claims; uninstall removes the
 * entry only when the last claim is released.
 */
export const StoreInstallClaimSchema = z.object({
  spaceId: z.string().uuid(),
  catalogId: CatalogIdSchema,
  claimedBy: StoreInstallClaimantSchema,
});
export type StoreInstallClaim = z.infer<typeof StoreInstallClaimSchema>;

export function buildBundleClaimant(bundleCatalogId: string): string {
  return `${BUNDLE_CLAIM_PREFIX}${bundleCatalogId}`;
}

export function parseStoreInstallClaimant(
  claimedBy: string,
): { kind: 'direct' } | { kind: 'bundle'; bundleCatalogId: string } | null {
  if (claimedBy === 'direct') return { kind: 'direct' };
  if (!claimedBy.startsWith(BUNDLE_CLAIM_PREFIX)) return null;
  const bundleCatalogId = claimedBy.slice(BUNDLE_CLAIM_PREFIX.length);
  if (!CatalogIdSchema.safeParse(bundleCatalogId).success) return null;
  return { kind: 'bundle', bundleCatalogId };
}
