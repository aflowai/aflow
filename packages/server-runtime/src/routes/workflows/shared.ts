/**
 * Shared workflow route schemas and helpers.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  createMemoryDocRepository,
  type MemoryDocRepository,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { WorkflowSchema, SkillValiditySchema, SkillCampaignContractSchema } from '@aflow/schemas';

export const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const WorkflowSlugParamSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  .min(3)
  .max(64);

export const WorkflowSlugParamsSchema = z.object({
  spaceId: z.string().uuid(),
  slug: WorkflowSlugParamSchema,
});

export const spaceReadAuthz = {
  resource: 'space' as const,
  action: 'read' as const,
  resourceIdFrom: 'param' as const,
  resourceIdParam: 'spaceId' as const,
};

export const spaceWriteAuthz = {
  resource: 'space' as const,
  action: 'write' as const,
  resourceIdFrom: 'param' as const,
  resourceIdParam: 'spaceId' as const,
};

/**
 * Deterministic UUID v5-shaped string for platform-owned (registry) workflows.
 * Platform workflows have no DB row, but `WorkflowSchema.id` requires a UUID;
 * derive a stable one from the slug so the response validates and the UI gets
 * a consistent identifier across reloads.
 */
export function platformWorkflowUuid(slug: string): string {
  const hash = createHash('sha1').update(`phoenix.platform.workflow:${slug}`).digest('hex');
  // RFC 4122 v5 layout: set version (5) and variant (10xx) bits.
  const v = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(
    (parseInt(hash.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, '0')}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
  return v;
}

export const WorkflowSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  mode: z.enum(['optimization', 'process', 'project']),
  status: z.enum(['draft', 'approved', 'completed', 'abandoned']),
  taskCount: z.number().int().nonnegative(),
  outcomeCount: z.number().int().nonnegative(),
  hasActivation: z.boolean(),
  hasAssignedAgent: z.boolean(),
  origin: z.string().nullable(),
  /** True for platform authoring skills (compose-skill, bind-capability, …) —
   *  the canonical set is `listPlatformSkillBundles()`. The operator-facing
   *  `/skills` list hides these; everything else treats them like any skill. */
  system: z.boolean().default(false),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /** ID of the underlying artifact — UUID for memory docs, `platform:{slug}` for registry. */
  docId: z.string(),
  sourceCatalogId: z.string().optional(),
  /** Set when the workflow JSON fails WorkflowSchema validation. The skill is
   *  visible but marked as needing repair — never silently dropped. */
  validationError: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  purgedAt: z.string().nullable().optional(),
  /** Audit attribution from the tombstone, if available. */
  purgedByUserId: z.string().uuid().nullable().optional(),
});

export const WorkflowDetailSchema = z.object({
  /** Validated workflow. Absent when the underlying JSON fails schema validation. */
  workflow: WorkflowSchema.optional(),
  /**
   * Raw workflow JSON. Always populated alongside `workflow` for valid
   * docs; used by the inspector to render a degraded view (and surface
   * the validation error) when `workflow` is absent.
   */
  rawWorkflow: z.unknown().optional(),
  /** Set when the workflow JSON fails `WorkflowSchema` validation. */
  validationError: z.string().nullable().optional(),
  /** ID of the underlying artifact — UUID for memory docs, `platform:{slug}` for registry. */
  docId: z.string(),
  /** Whether the workflow has a `/workflows/{slug}/ledger.json` companion. */
  hasLedger: z.boolean(),
  /** Whether the workflow has any `/evals/{slug}/...` companion docs. */
  hasEvalSuite: z.boolean(),
  /** Contract validity recomputed at read (Plan 190) — drives the designer's
   *  issues surface. Present only for a schema-valid workflow. */
  contractValidity: SkillValiditySchema.optional(),
  /** The skill's campaign contract (field definitions) from its SkillManifest,
   *  if it declares one — gives `$campaign` refs a definition in the designer. */
  campaign: SkillCampaignContractSchema.optional(),
  archivedAt: z.string().nullable().optional(),
  purgedAt: z.string().nullable().optional(),
  purgedByUserId: z.string().uuid().nullable().optional(),
  /** When purged, the last-known display name from the tombstone. */
  tombstoneName: z.string().nullable().optional(),
});

export function getDb(fastify: FastifyInstance): PostgresJsDatabase {
  return fastify.appContext.db as PostgresJsDatabase;
}

export function createWorkflowRepo(
  fastify: FastifyInstance,
  tenantId: TenantId,
): MemoryDocRepository {
  const tenantCtx = createTenantContext(tenantId);
  return createMemoryDocRepository(getDb(fastify), tenantCtx);
}

export async function publishWorkflowUpdatedEvent(
  fastify: FastifyInstance,
  spaceId: string,
  workflowSlug: string,
): Promise<void> {
  const redis = fastify.appContext.redis;
  if (!redis) return;
  await redis
    .publish(
      `entity:${spaceId}:events`,
      JSON.stringify({
        type: 'entity.procedure.updated',
        spaceId,
        workflowSlug,
        timestamp: new Date().toISOString(),
      }),
    )
    .catch(() => {});
}
