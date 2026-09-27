import { z } from 'zod';
import { CatalogIdSchema, HostPatternSchema } from './catalogEntry.js';
import { EgressApprovalStatusSchema } from '../runtime/spaceContext.js';

export const IntegrationPolicyModeSchema = z.enum(['open', 'allowlist']);
export type IntegrationPolicyMode = z.infer<typeof IntegrationPolicyModeSchema>;

export const IntegrationAllowlistKindSchema = z.enum(['api', 'mcp']);
export type IntegrationAllowlistKind = z.infer<typeof IntegrationAllowlistKindSchema>;

export const StoreListingAvailabilitySchema = z.enum(['available', 'hidden']);
export type StoreListingAvailability = z.infer<typeof StoreListingAvailabilitySchema>;

export const TenantSignupPolicySchema = z.enum(['invite_only', 'open']);
export type TenantSignupPolicy = z.infer<typeof TenantSignupPolicySchema>;

export const TenantQuotasSchema = z.object({
  maxSpacesPerUser: z.number().int().min(1).optional(),
  /** Daily embedding token budget per space; absent = unlimited. */
  embeddingDailyTokensPerSpace: z.number().int().min(1).optional(),
  /** Daily embedding token budget for the whole tenant; absent = unlimited. */
  embeddingDailyTokensTenant: z.number().int().min(1).optional(),
  /** Daily compute-sandbox seconds per space; absent = unlimited. */
  computeDailySecondsPerSpace: z.number().int().min(1).optional(),
  /** Daily compute-sandbox seconds for the whole tenant; absent = unlimited. */
  computeDailySecondsTenant: z.number().int().min(1).optional(),
});
export type TenantQuotas = z.infer<typeof TenantQuotasSchema>;

/** Quotas are recomputed from the stored JSON at every read; malformed or absent values mean unlimited. */
export function parseTenantQuotas(value: unknown): TenantQuotas {
  const parsed = TenantQuotasSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Tenant-wide capability exclusion ANDed over every space profile, so member
 * profile-switching cannot widen authority. Pierced per user by tenant
 * capability grants.
 */
export const TenantCapabilityCeilingSchema = z.object({
  excludedGroups: z.array(z.string().min(1).max(128)).max(64),
});
export type TenantCapabilityCeiling = z.infer<typeof TenantCapabilityCeilingSchema>;

export function parseTenantCapabilityCeiling(value: unknown): TenantCapabilityCeiling | null {
  if (value == null) return null;
  const parsed = TenantCapabilityCeilingSchema.safeParse(value);
  if (!parsed.success || parsed.data.excludedGroups.length === 0) return null;
  return parsed.data;
}

export const TenantIntegrationAllowlistEntrySchema = z.object({
  id: z.string().uuid(),
  kind: IntegrationAllowlistKindSchema,
  hostPattern: HostPatternSchema,
  note: z.string().max(500).optional(),
  addedBy: z.string().max(256).optional(),
  addedAt: z.string().datetime(),
});
export type TenantIntegrationAllowlistEntry = z.infer<typeof TenantIntegrationAllowlistEntrySchema>;

export const TenantIntegrationAllowlistCreateSchema = z.object({
  kind: IntegrationAllowlistKindSchema,
  hostPattern: HostPatternSchema,
  note: z.string().max(500).optional(),
});
export type TenantIntegrationAllowlistCreate = z.infer<
  typeof TenantIntegrationAllowlistCreateSchema
>;

export const TenantStoreOverrideSchema = z.object({
  catalogId: CatalogIdSchema,
  availability: StoreListingAvailabilitySchema,
});
export type TenantStoreOverride = z.infer<typeof TenantStoreOverrideSchema>;

export const IntegrationHostRequestCreateSchema = z.object({
  kind: IntegrationAllowlistKindSchema,
  hostPattern: HostPatternSchema,
  reason: z.string().max(1000).optional(),
});
export type IntegrationHostRequestCreate = z.infer<typeof IntegrationHostRequestCreateSchema>;

export const IntegrationHostRequestSchema = z.object({
  requestId: z.string().uuid(),
  kind: IntegrationAllowlistKindSchema,
  hostPattern: z.string(),
  spaceId: z.string().uuid().optional(),
  requestedBy: z.string().max(256),
  requestedAt: z.string().datetime(),
  reason: z.string().max(1000).optional(),
  status: EgressApprovalStatusSchema,
  reviewedBy: z.string().max(256).optional(),
  reviewedAt: z.string().datetime().optional(),
  reviewNote: z.string().max(1000).optional(),
});
export type IntegrationHostRequest = z.infer<typeof IntegrationHostRequestSchema>;
