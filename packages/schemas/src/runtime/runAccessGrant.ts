import { z } from 'zod';

// ============================================================================
// Grant TTL
// ============================================================================

/** Default grant TTL in seconds (10 minutes). */
export const RUN_ACCESS_GRANT_TTL_SECONDS = 10 * 60;

// ============================================================================
// Capability Entry (group + access mode pair)
// ============================================================================

export const CapabilityEntrySchema = z.object({
  /** Capability group ID — derived from stepType.group (e.g., 'ai.text', 'memory.store') */
  capabilityGroupId: z.string(),
  /** Access mode: read or write */
  accessMode: z.enum(['read', 'write']),
});

export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

// ============================================================================
// Capability Snapshot
// ============================================================================

export const CapabilitySnapshotSchema = z.object({
  /** Allowed capability group + access mode pairs. If non-empty, only these are allowed. */
  allowedCapabilities: z.array(CapabilityEntrySchema).default([]),
  /** Explicitly denied capability group + access mode pairs (higher priority than allow). */
  deniedCapabilities: z.array(CapabilityEntrySchema).default([]),
  /** Allowed risk modifiers (e.g., ['external_side_effect']). Empty = none allowed. */
  allowedRiskModifiers: z.array(z.string()).default([]),
  /** Denied risk modifiers (higher priority than allow). */
  deniedRiskModifiers: z.array(z.string()).default([]),
  /** Allow privileged operations (platform.*, agent.manage.*) */
  allowPrivileged: z.boolean().default(false),
});

export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;

// ============================================================================
// Grant Reason
// ============================================================================

export const GrantReasonSchema = z.enum(['start', 'resume', 'admin_resume', 'api_key_start']);

export type GrantReason = z.infer<typeof GrantReasonSchema>;

// ============================================================================
// Run Access Grant
// ============================================================================

export const RunAccessGrantSchema = z.object({
  /** Space ID this grant is scoped to (immutable for the run) */
  spaceId: z.string().uuid(),

  /** Access level in the space: read or write */
  accessLevel: z.enum(['read', 'write']),

  /** User ID who was evaluated for this grant */
  grantedToUserId: z.string().uuid(),

  /** Tenant role at grant time (for attribution, not enforcement) */
  tenantRole: z.string(),

  /** Space role at grant time */
  spaceRole: z.string(),

  /** When this grant was computed (ISO 8601) */
  grantedAt: z.string().datetime(),

  /** When this grant expires (ISO 8601). The scheduler recompiles it past this. */
  expiresAt: z.string().datetime(),

  /** Capability snapshot: allowed/denied capabilities. */
  capabilities: CapabilitySnapshotSchema,

  /** Why this grant was issued */
  grantReason: GrantReasonSchema.optional(),

  // --- Provenance (for audit/debugging) ---

  /** Policy profile ID used to compile this grant (future: tenant-managed profiles) */
  compiledProfileId: z.string().optional(),
  /**
   * Human-readable profile name, carried so a denial can say which profile
   * refused. An operator cannot act on a UUID.
   */
  compiledProfileName: z.string().optional(),
  /** Version of the policy profile */
  compiledProfileVersion: z.number().int().optional(),
  /** Version of the grant compiler */
  compilerVersion: z.string().optional(),

  /**
   * Resource-scoped grants (bounded, typed).
   * Phase 1: always empty. Phase 2+: may contain per-resource grants from OpenFGA.
   * Hard limit: max 50 entries per grant.
   */
  resourceScopes: z
    .array(
      z.object({
        resourceType: z.string(),
        resourceId: z.string(),
        actions: z.array(z.string()),
      }),
    )
    .max(50)
    .default([]),
});

export type RunAccessGrant = z.infer<typeof RunAccessGrantSchema>;

// ============================================================================
// Grant Enforcement (pure CPU — no I/O)
// ============================================================================

/**
 * A refusal denies the step; it never parks the run.
 *
 * Pausing on an authorization gap looks like it defers to a human, but nothing
 * can act on it: the refusal happens before any step state exists, so the pause
 * carries no resume contract, and neither resume nor retry can clear it. An
 * autonomous run — a workflow-task Runner with no human watching — is stranded
 * outright, and its parent waits forever on a task that will never land.
 *
 * Denying instead keeps every session on a path it can act on. A refused tool
 * call reaches the agent as a non-retryable permission error, which a Runner
 * answers with `signal_blocked`; a refused agent turn fails the run, which is
 * the visible outcome an operator can actually see and re-drive.
 */
export type GrantEnforcementResult = { allowed: true } | { allowed: false; reason: string };

/** Per-call op-task-only controls passed into `enforceGrant`. */
export interface OpAccessControls {
  /** True if this op may only be invoked from an explicit operation task. */
  opTaskOnly?: boolean;
  /** True if the resolved binding marks this op as op-task-only. */
  bindingTaskOnly?: boolean;
}

export interface CallerContext {
  /** 'agent' = invoked inside an agent's autonomous tool loop (Helmsman or Runner).
   *  'op_task' = directly invoked by a workflow operation task. */
  kind: 'agent' | 'op_task';
}

export function enforceGrant(
  grant: RunAccessGrant | null,
  operationId: string,
  opMutates: boolean,
  opPrivileged: boolean,
  opCapabilityGroupId: string,
  opAccessMode: string,
  opRiskModifiers: string[],
  controls: OpAccessControls = {},
  caller: CallerContext = { kind: 'agent' },
): GrantEnforcementResult {
  // 1. No usable grant → deny. The scheduler recompiles a missing or aged-out
  // grant before reaching here, so arriving with one means renewal found no
  // authority to renew from — retrying cannot change that.
  if (!grant) {
    return {
      allowed: false,
      reason: `Operation ${operationId} is not authorized — this run has no access grant and none could be derived from the authority it was started under. Do not retry.`,
    };
  }

  const now = new Date();
  if (new Date(grant.expiresAt) <= now) {
    return {
      allowed: false,
      reason: `Operation ${operationId} is not authorized — this run's access grant expired and could not be renewed. Do not retry.`,
    };
  }

  // 2. Mutating operation on read-only grant → deny step
  if (opMutates && grant.accessLevel === 'read') {
    return {
      allowed: false,
      reason: `Operation ${operationId} mutates state but run has read-only access`,
    };
  }

  const { capabilities } = grant;

  // 3. Denied capabilities (highest priority).
  if (capabilities.deniedCapabilities.length > 0) {
    const denied = capabilities.deniedCapabilities.some(
      (c) => c.capabilityGroupId === opCapabilityGroupId && c.accessMode === opAccessMode,
    );
    if (denied) {
      return {
        allowed: false,
        reason: `Operation ${operationId} (${opCapabilityGroupId}:${opAccessMode}) is explicitly denied by grant`,
      };
    }
  }

  // 4. Allowed capabilities (must match when non-empty).
  if (capabilities.allowedCapabilities.length > 0) {
    const capAllowed = capabilities.allowedCapabilities.some(
      (c) => c.capabilityGroupId === opCapabilityGroupId && c.accessMode === opAccessMode,
    );
    if (!capAllowed) {
      // Name the gate that refused. Several unrelated gates can deny the same
      // operation — the space's operator policy, the run's capability grant,
      // the tool surface — and a message that does not distinguish them sends
      // the agent to change a setting that was never the blocker.
      const profile = grant.compiledProfileName
        ? `the "${grant.compiledProfileName}" capability profile`
        : `this session's capability profile`;
      const grantedForGroup = capabilities.allowedCapabilities
        .filter((c) => c.capabilityGroupId === opCapabilityGroupId)
        .map((c) => c.accessMode);
      const detail =
        grantedForGroup.length > 0
          ? `${profile} grants ${opCapabilityGroupId}:${grantedForGroup.join('/')} but not :${opAccessMode}`
          : `${profile} does not include ${opCapabilityGroupId}`;

      return {
        allowed: false,
        reason: `Operation ${operationId} is not available — ${detail}. This is the space's capability profile, not its feature settings, so toggling the feature on will not change it. A tenant admin has to assign this space a profile that includes ${opCapabilityGroupId}:${opAccessMode}. Do not retry.`,
      };
    }
  }

  // 5. Risk modifier checks
  if (opRiskModifiers.length > 0) {
    if (capabilities.deniedRiskModifiers.length > 0) {
      const deniedMod = opRiskModifiers.find((m) => capabilities.deniedRiskModifiers.includes(m));
      if (deniedMod) {
        return {
          allowed: false,
          reason: `Operation ${operationId} requires risk modifier '${deniedMod}' which is denied`,
        };
      }
    }

    for (const mod of opRiskModifiers) {
      if (mod === 'privileged') continue;
      if (!capabilities.allowedRiskModifiers.includes(mod)) {
        return {
          allowed: false,
          reason: `Operation ${operationId} requires risk modifier '${mod}' which is not allowed`,
        };
      }
    }
  }

  // 6. Privileged operations require allowPrivileged
  if (opPrivileged && !capabilities.allowPrivileged) {
    return {
      allowed: false,
      reason: `Operation ${operationId} is privileged but grant does not allow privileged operations`,
    };
  }

  if (
    caller.kind === 'agent' &&
    (controls.opTaskOnly === true || controls.bindingTaskOnly === true)
  ) {
    return {
      allowed: false,
      reason: `Operation ${operationId} is op-task-only and cannot be invoked by an agent. Place it as an operation task in a workflow graph.`,
    };
  }

  // 8. Allow
  return { allowed: true };
}
