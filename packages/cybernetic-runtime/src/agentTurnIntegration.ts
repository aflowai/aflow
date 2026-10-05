import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type {
  ActiveMemoryInjection,
  EntityDirectives,
  EntitySelfModel,
  EntityEventType,
  SpaceContextConsumerRole,
} from '@aflow/schemas';
import { buildActiveMemoryInjection, eligibleActiveEntries } from '@aflow/schemas';
import { eq, and, isNull } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  memoryDocs,
  loadActiveMemorySpaceState,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

import { appendEntityEvent } from '@aflow/redis';
import { assembleHelmsmanPrompt, type HelmsmanCapabilities } from './helmsmanPrompt.js';
import { readAttentionForTurn } from './attentionTurn.js';
import { loadConversationPlanRoots } from './plan/attention.js';
import { getCyberneticLogger } from './logger.js';
import { emitPhaseIfChanged } from './interactionPhase.js';

// ============================================================================
// Types
// ============================================================================

export interface CyberneticTurnOverrides {
  /** Assembled cybernetic system prompt (replaces default) */
  systemPrompt: string;
  /** Volatile attention context block (injected per turn) */
  attentionContextBlock: {
    key: string;
    content: string;
    cacheHint: 'volatile';
  };
  /**
   * Ephemeral [anchor:user, memory:assistant] pair for the Helmsman turn.
   * Only ever set on this Helmsman-only path — Runner/Coach sessions never
   * receive it. Absent when the space is not personal or nothing is active.
   */
  activeMemory?: ActiveMemoryInjection;
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if the current agent is a cybernetic Helmsman in a cybernetic space.
 *
 * A space is cybernetic if it has `directives` set (non-null).
 * An agent is the Helmsman if it has `system: true` and tags include 'helmsman' and 'cybernetic'.
 */
export function isCyberneticHelmsman(
  agentMeta: { system?: boolean; tags?: string[] } | undefined,
  directives: unknown,
): boolean {
  if (!directives) return false;
  return isHelmsmanDefinition(agentMeta);
}

/**
 * Whether the definition is the Helmsman, from its own metadata alone. A space
 * with no directives yet is still steered by the Helmsman, and the surface
 * composed for the edition applies to it before any directive exists.
 */
export function isHelmsmanDefinition(
  agentMeta: { system?: boolean; tags?: string[] } | undefined,
): boolean {
  if (!agentMeta?.system) return false;
  const tags = agentMeta.tags ?? [];
  return tags.includes('helmsman') && tags.includes('cybernetic');
}

export function isCyberneticCoach(
  agentMeta: { system?: boolean; tags?: string[] } | undefined,
  directives: unknown,
): boolean {
  if (!directives) return false;
  if (!agentMeta?.system) return false;
  const tags = agentMeta.tags ?? [];
  return tags.includes('coach') && tags.includes('cybernetic');
}

export function isCyberneticRunner(
  agentMeta: { system?: boolean; tags?: string[] } | undefined,
  directives: unknown,
): boolean {
  if (!directives) return false;
  if (!agentMeta?.system) return false;
  const tags = agentMeta.tags ?? [];
  return tags.includes('runner') && tags.includes('cybernetic');
}

/**
 * Which role's `SpaceContext` projection this agent should receive.
 *
 * Anything the three predicates do not claim is `other` — a custom agent, or
 * any agent in a non-cybernetic space. `other` keeps the governance triple,
 * because an agent whose prompt this module cannot inspect may have no other
 * statement of the space's mandate.
 */
export function resolveSpaceContextRole(
  agentMeta: { system?: boolean; tags?: string[] } | undefined,
  directives: unknown,
): SpaceContextConsumerRole {
  if (isCyberneticHelmsman(agentMeta, directives)) return 'helmsman';
  if (isCyberneticCoach(agentMeta, directives)) return 'coach';
  if (isCyberneticRunner(agentMeta, directives)) return 'runner';
  return 'other';
}

// ============================================================================
// Turn overrides
// ============================================================================

/**
 * Build cybernetic overrides for the agent turn pipeline.
 *
 * Called once per session start (for the system prompt) and on each turn (for attention context).
 * Returns null if this is not a cybernetic Helmsman session.
 */
/**
 * The two load-bearing injection gates in one testable place: only a PERSONAL
 * space injects, and only eligible (active, promoted, unexpired, schema-valid)
 * entries project. Anything else — shared space, candidates-only, missing
 * space — yields null.
 */
export function resolveActiveMemoryInjection(
  spaceState: { singleOwner: boolean; register: unknown } | null,
  nowIso: string,
): ActiveMemoryInjection | null {
  // singleOwner (not type === personal) is the gate: a personal space with an
  // added member is NOT single-principal, so member B's promoted memory must
  // not inject for owner A.
  if (!spaceState?.singleOwner) return null;
  return buildActiveMemoryInjection(eligibleActiveEntries(spaceState.register, nowIso));
}

export async function buildCyberneticTurnOverrides(params: {
  tenantId: string;
  spaceId: string;
  /** The Helmsman conversation the turn is in: the attention block is rendered for it. */
  sessionId: string;
  spaceName: string;
  directives: EntityDirectives;
  db: PostgresJsDatabase;
  redis: Redis;
  /**
   * What this space can reach. Omitted means "everything" — an unknown space
   * keeps the full prompt rather than silently losing doctrine.
   */
  capabilities?: HelmsmanCapabilities;
}): Promise<CyberneticTurnOverrides> {
  const { tenantId, spaceId, spaceName, directives, db, redis } = params;
  const logger = getCyberneticLogger();

  // 104b: Helmsman is actively processing → emit 'decide' phase
  emitPhaseIfChanged({
    tenantId,
    spaceId,
    redis,
    inputs: {
      helmsmanStatus: 'running',
      activeRunnerSessions: [],
      activeCoachSessions: [],
    },
  });

  // Load self-model from space memory
  let selfModel: EntitySelfModel | undefined;
  try {
    const tenantCtx = createTenantContext(tenantId as TenantId);
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ inlineContent: memoryDocs.inlineContent })
        .from(memoryDocs)
        .where(
          and(
            eq(memoryDocs.spaceId, spaceId),
            eq(memoryDocs.path, '/identity/self-model.json'),
            isNull(memoryDocs.deletedAt),
          ),
        )
        .limit(1),
    );

    if (rows[0]?.inlineContent) {
      selfModel = JSON.parse(rows[0].inlineContent) as EntitySelfModel;
    }
  } catch (err) {
    logger.warn(
      `cybernetic: failed to load self-model for spaceId=${spaceId}, proceeding without it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build the system prompt
  //
  const systemPrompt = assembleHelmsmanPrompt({
    spaceName,
    directives,
    selfModel,
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
  });

  // Read per turn, not cached with the block: it is this conversation's, and
  // the block is the space's.
  const planRootIds = await loadConversationPlanRoots({
    db,
    tenantId,
    spaceId,
    sessionId: params.sessionId,
  }).catch((err: unknown) => {
    logger.warn(
      "buildCyberneticTurnOverrides: the conversation's plan roots could not be read; every run in the plan reads as another's: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return [];
  });
  const attentionText = await readAttentionForTurn({
    tenantId,
    spaceId,
    sessionId: params.sessionId,
    conversation: { planRootIds },
    db,
    redis,
  });

  let activeMemory: ActiveMemoryInjection | undefined;
  try {
    const tenantCtx = createTenantContext(tenantId as TenantId);
    const spaceState = await loadActiveMemorySpaceState(db, tenantCtx, spaceId);
    const injection = resolveActiveMemoryInjection(spaceState, new Date().toISOString());
    if (injection) activeMemory = injection;
  } catch (err) {
    getCyberneticLogger().warn(
      `buildCyberneticTurnOverrides: active-memory load failed (skipping injection): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    systemPrompt,
    attentionContextBlock: {
      key: 'HelmsmanAttention',
      content: attentionText,
      cacheHint: 'volatile' as const,
    },
    ...(activeMemory ? { activeMemory } : {}),
  };
}

// ============================================================================
// Entity event emission
// ============================================================================

/**
 * Emit a cybernetic entity event. Convenience wrapper around appendEntityEvent
 * that fills in common fields (spaceId, tenantId, timestamp).
 *
 * Non-blocking: returns immediately, errors are logged but not thrown.
 */
export async function emitEntityEvent(params: {
  redis: Redis;
  tenantId: string;
  spaceId: string;
  eventType: EntityEventType;
  summary: string;
  payload?: Record<string, unknown>;
  causedBySessionId?: string;
  causedByStepExecutionId?: string;
  workflowSlug?: string;
  operatingMode?: 'conversational' | 'exploratory' | 'procedural' | 'supervisory';
  traceId?: string;
}): Promise<string | null> {
  const { redis, tenantId, spaceId, eventType, summary, ...rest } = params;
  try {
    const { randomUUID } = await import('node:crypto');
    const event = {
      eventId: randomUUID(),
      eventType,
      spaceId,
      tenantId,
      timestamp: Date.now(),
      summary,
      payload: rest.payload ?? {},
      ...(rest.causedBySessionId ? { causedBySessionId: rest.causedBySessionId } : {}),
      ...(rest.causedByStepExecutionId
        ? { causedByStepExecutionId: rest.causedByStepExecutionId }
        : {}),
      ...(rest.workflowSlug ? { workflowSlug: rest.workflowSlug } : {}),
      ...(rest.operatingMode ? { operatingMode: rest.operatingMode } : {}),
      ...(rest.traceId ? { traceId: rest.traceId } : {}),
    };
    return await appendEntityEvent(redis, { tenantId, spaceId, event });
  } catch (err) {
    getCyberneticLogger().warn(
      `emitEntityEvent: failed to emit ${eventType}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
