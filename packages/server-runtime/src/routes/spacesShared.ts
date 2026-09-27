/**
 * Space route helpers — response schemas, DTO mapping, write-gate helpers.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  tenants,
  spaceMemberships,
} from '@aflow/database';
import {
  SpaceComputePolicySchema,
  SpaceCodePolicySchema,
  SpaceWriteApprovalPolicySchema,
  DirectiveConnectionRefSchema,
  EntityDirectivesSchema,
  CLERK_MODEL_CANDIDATES,
} from '@aflow/schemas';
import {
  allowedModelIds,
  canonicalModelId,
  isModelIdAllowed,
  isRoleModeNotRef,
} from '../lib/agentModelPolicy.js';

export const ErrorSchema = z.object({ error: z.string(), message: z.string() });

/** What a tenant lets a space assign to a cybernetic role. */
export interface AgentModelPolicy {
  /** Permitted catalog ids, resolved through the one allowlist resolver. */
  ids: ReadonlySet<string>;
  /** The tenant named its own set, so no platform recommendation is in play. */
  explicit: boolean;
}

/**
 * Off-list model refs in a directives write. Stored directives stay permissive
 * (existing spaces keep reading/running); only writes are held to the set the
 * tenant allows.
 */
export function offListAgentModelRefs(
  directives: z.infer<typeof EntityDirectivesSchema> | null | undefined,
  policy: AgentModelPolicy,
): string[] {
  const defaults = directives?.modelDefaults;
  if (!defaults) return [];
  const offList = new Set<string>();
  for (const [role, value] of Object.entries(defaults)) {
    if (typeof value !== 'string' || isRoleModeNotRef(role, value)) continue;
    if (!isModelIdAllowed(value, roleAllowed(role, policy))) offList.add(value);
  }
  return [...offList];
}

/**
 * The set a given role may be assigned from.
 *
 * One resolver still decides what a tenant permits; what differs is which
 * models the PLATFORM recommends for a role. The small models the Clerk exists
 * to use are deliberately absent from the foreground lineup, so holding the
 * Clerk to that lineup refuses every economical model the picker offers and
 * leaves only the expensive ones the role exists to avoid. A tenant that named
 * its own set stays authoritative for every role alike: the recommendation is
 * what an unset allowlist means, never an exemption from one.
 */
function roleAllowed(role: string, policy: AgentModelPolicy): ReadonlySet<string> {
  if (role !== 'clerk' || policy.explicit) return policy.ids;
  const widened = new Set(policy.ids);
  for (const refs of Object.values(CLERK_MODEL_CANDIDATES)) {
    for (const ref of refs) {
      const id = canonicalModelId(ref);
      if (id) widened.add(id);
    }
  }
  return widened;
}

/**
 * The models this tenant lets a space assign to a cybernetic role.
 *
 * Read per write rather than cached: an admin widening the set expects the very
 * next save to accept the model they just enabled.
 */
export async function allowedAgentModelRefs(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<AgentModelPolicy> {
  const rows = await db
    .select({ allowlist: tenants.agentModelAllowlist })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  const stored = rows[0]?.allowlist;
  const explicit = Array.isArray(stored) && stored.length > 0;
  return { ids: allowedModelIds(explicit ? (stored as string[]) : null), explicit };
}

/**
 * Bindings placed always-on, each with the tool subset it pins — `null` for
 * every tool. The subset has to survive this parse: charging a connection its
 * whole surface would refuse a selection the composer just showed as fitting,
 * which is the one edit an over-cap operator can make.
 *
 * Per binding, not per integration: the pinned tier emits binding-scoped tools
 * so the agent transacts through the account the operator named. A row the
 * contract rejects, or one naming no binding, is skipped — neither pins
 * anything at runtime either.
 *
 * Mirrors the orchestrator's own resolution: an entry naming no binding cannot
 * be pinned, and an empty subset pins nothing rather than everything.
 */
export function alwaysOnBindingTools(connections: unknown): Map<string, string[] | null> {
  const pinned = new Map<string, string[] | null>();
  if (!Array.isArray(connections)) return pinned;
  for (const raw of connections) {
    const parsed = DirectiveConnectionRefSchema.safeParse(raw);
    if (!parsed.success || parsed.data.placement !== 'always_on') continue;
    if (parsed.data.bindingId === undefined) continue;
    if (parsed.data.pinnedToolNames?.length === 0) continue;
    pinned.set(parsed.data.bindingId, parsed.data.pinnedToolNames ?? null);
  }
  return pinned;
}

/**
 * Roles the create body named before validation supplied the rest. Keyed by
 * request so the two hooks cannot see each other's state.
 */
export const chosenModelRoles = new WeakMap<FastifyRequest, ReadonlySet<string>>();

/**
 * Excluded models this write newly assigns to a role.
 *
 * A role that already holds an excluded model keeps it — narrowing the tenant
 * set blocks new assignments and leaves running ones alone — but only for that
 * role, and only while it is the same model rather than the same string.
 */
export function introducedOffListModels(
  next: z.infer<typeof EntityDirectivesSchema> | null | undefined,
  stored: Record<string, string> | undefined,
  policy: AgentModelPolicy,
): string[] {
  const proposed = next?.modelDefaults;
  if (!proposed) return [];
  const introduced: string[] = [];
  for (const [role, ref] of Object.entries(proposed)) {
    if (typeof ref !== 'string' || isRoleModeNotRef(role, ref)) continue;
    if (isModelIdAllowed(ref, roleAllowed(role, policy))) continue;
    const priorForRole = stored?.[role];
    const unchanged =
      priorForRole !== undefined && canonicalModelId(priorForRole) === canonicalModelId(ref);
    if (!unchanged) introduced.push(ref);
  }
  return [...new Set(introduced)];
}

export function offListAgentModelError(
  offList: string[],
  allowed: ReadonlySet<string>,
): { error: string; message: string } {
  return {
    error: 'AGENT_MODEL_NOT_ALLOWED',
    message:
      `Not enabled for this tenant: ${offList.join(', ')}. ` +
      `Choose one of: ${[...allowed].join(', ')}. ` +
      `A tenant admin can change the set in Settings → Models.`,
  };
}

export const SpaceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  /** Explicit membership rows — solo (≤1) renders as a personal space */
  memberCount: z.number().int().min(0),
  ownerId: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  /** User's role in this space, or null if not a member (tenant admins still have access) */
  myRole: z.enum(['admin', 'editor', 'viewer']).nullable().optional(),
  defaultTarget: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('platform-role'), systemRole: z.string() }),
      z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
    ])
    .nullable()
    .optional(),
  /** Single-string identifier for the default — platform systemRole or custom-agent UUID. Stable across renames. */
  defaultAgentId: z.string().nullable().optional(),
  rules: z.array(z.object({ text: z.string() })).optional(),
  computePolicy: SpaceComputePolicySchema.nullable().optional(),
  codePolicy: SpaceCodePolicySchema.nullable().optional(),
  writePolicy: SpaceWriteApprovalPolicySchema.nullable().optional(),
  directives: EntityDirectivesSchema.nullable().optional(),
});

export const MemberResponseSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'editor', 'viewer']),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
});

export type SpaceResponse = z.infer<typeof SpaceResponseSchema>;

export function toSpaceResponse(r: Record<string, unknown>): SpaceResponse {
  const targetKind =
    (r['defaultTargetKind'] as string | null | undefined) ??
    (r['default_target_kind'] as string | null | undefined) ??
    null;
  const targetSystemRole =
    (r['defaultTargetSystemRole'] as string | null | undefined) ??
    (r['default_target_system_role'] as string | null | undefined) ??
    null;
  const targetAgentId =
    (r['defaultTargetAgentId'] as string | null | undefined) ??
    (r['default_target_agent_id'] as string | null | undefined) ??
    null;
  let defaultTarget: SpaceResponse['defaultTarget'] = null;
  if (targetKind === 'platform-role' && targetSystemRole) {
    defaultTarget = { kind: 'platform-role', systemRole: targetSystemRole };
  } else if (targetKind === 'custom-agent' && targetAgentId) {
    defaultTarget = { kind: 'custom-agent', agentId: targetAgentId };
  }
  const archivedRaw =
    (r['archivedAt'] as string | Date | null | undefined) ??
    (r['archived_at'] as string | Date | null | undefined) ??
    null;
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    slug: r['slug'] as string,
    description: (r['description'] as string | null | undefined) ?? null,
    memberCount: (r['memberCount'] as number | undefined) ?? 0,
    ownerId:
      (r['ownerId'] as string | null | undefined) ??
      (r['owner_id'] as string | null | undefined) ??
      null,
    createdBy:
      (r['createdBy'] as string | null | undefined) ??
      (r['created_by'] as string | null | undefined) ??
      null,
    createdAt: new Date(
      (r['createdAt'] as string | undefined) ?? (r['created_at'] as string | undefined) ?? '',
    ).toISOString(),
    updatedAt: new Date(
      (r['updatedAt'] as string | undefined) ?? (r['updated_at'] as string | undefined) ?? '',
    ).toISOString(),
    archivedAt: archivedRaw ? new Date(archivedRaw).toISOString() : null,
    defaultTarget,
    defaultAgentId: targetSystemRole ?? targetAgentId ?? null,
    rules: (r['rules'] as Array<{ text: string }> | undefined) ?? [],
    computePolicy:
      (r['computePolicy'] as z.infer<typeof SpaceComputePolicySchema> | null | undefined) ??
      (r['compute_policy'] as z.infer<typeof SpaceComputePolicySchema> | null | undefined) ??
      null,
    codePolicy:
      (r['codePolicy'] as z.infer<typeof SpaceCodePolicySchema> | null | undefined) ??
      (r['code_policy'] as z.infer<typeof SpaceCodePolicySchema> | null | undefined) ??
      null,
    writePolicy:
      (r['writePolicy'] as z.infer<typeof SpaceWriteApprovalPolicySchema> | null | undefined) ??
      (r['write_policy'] as z.infer<typeof SpaceWriteApprovalPolicySchema> | null | undefined) ??
      null,
    directives:
      (r['directives'] as z.infer<typeof EntityDirectivesSchema> | null | undefined) ?? null,
  };
}

export async function getSpaceMemberCount(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)));
  return rows[0]?.count ?? 0;
}

export async function getSpaceOwnerId(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as Parameters<typeof createTenantContext>[0]);
  const rows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
    return (tx as PostgresJsDatabase)
      .select({ ownerId: spaces.ownerId })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
  })) as Array<{ ownerId: string | null }>;
  return rows[0]?.ownerId ?? null;
}
