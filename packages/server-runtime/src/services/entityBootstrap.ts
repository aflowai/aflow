import { createHash, randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { eq, and, isNull } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  memoryDirs,
  memoryDocs,
  memoryDocVersions,
  spaces,
} from '@aflow/database';
import { getPlatformAgentBySystemRole } from '@aflow/platform-artifacts';
import type {
  AgentSystemRole,
  EntityDirectives,
  EntityEventEnvelope,
  EntityEventType,
  EntitySelfModel,
  TenantId,
} from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';

// ============================================================================
// Seeded directory structure
// ============================================================================

/** Directories to create during entity instantiation. */
const SEEDED_DIRS: Array<{
  path: string;
  name: string;
  parentPath: string | null;
  description: string;
}> = [
  {
    path: '/identity',
    name: 'identity',
    parentPath: '/',
    description: 'Entity self-model and emergent identity',
  },
  {
    path: '/interactions',
    name: 'interactions',
    parentPath: '/',
    description: 'Episodic interaction memory',
  },
  {
    path: '/relationships',
    name: 'relationships',
    parentPath: '/',
    description: 'Per-user relationship memory',
  },
  {
    path: '/knowledge',
    name: 'knowledge',
    parentPath: '/',
    description: 'Domain knowledge, decisions, and reference material',
  },
  {
    path: '/knowledge/domain',
    name: 'domain',
    parentPath: '/knowledge',
    description: 'Domain-specific knowledge',
  },
  {
    path: '/knowledge/decisions',
    name: 'decisions',
    parentPath: '/knowledge',
    description: 'Recorded decisions and rationale',
  },
  {
    path: '/knowledge/reference',
    name: 'reference',
    parentPath: '/knowledge',
    description: 'Reference material and documentation',
  },
  {
    path: '/coach',
    name: 'coach',
    parentPath: '/',
    description: 'Coach staging and anomaly tracking',
  },
  {
    path: '/coach/staged',
    name: 'staged',
    parentPath: '/coach',
    description: 'Staged proposals awaiting review',
  },
  {
    path: '/coach/anomalies',
    name: 'anomalies',
    parentPath: '/coach',
    description: 'Detected anomalies and deviations',
  },
  {
    path: '/helmsman/drafts',
    name: 'drafts',
    parentPath: '/helmsman',
    description: 'Helmsman draft artifacts',
  },
  { path: '/helmsman', name: 'helmsman', parentPath: '/', description: 'Helmsman working area' },
  {
    path: '/evals',
    name: 'evals',
    parentPath: '/',
    description: 'Evaluation results and criteria',
  },
];

/**
 * Sort dirs so parents are created before children.
 * Simple depth-first by counting path segments.
 */
function sortedDirs() {
  return [...SEEDED_DIRS].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
}

// ============================================================================
// Cybernetic agent resolution
// ============================================================================

/**
 * The three cybernetic ensemble roles 102h Phase 1 seeds per tenant.
 *
 * Exported so tests can cross-check against `CYBERNETIC_AGENTS` in
 * `@aflow/database/seeds/cyberneticAgents` — Phase 2's resolver and Phase 1's
 * seed MUST agree or bootstrap fails with a "missing ensemble" error.
 */
export const CYBERNETIC_ROLES = [
  'cybernetic-helmsman',
  'cybernetic-runner',
  'cybernetic-coach',
] as const satisfies readonly AgentSystemRole[];

export interface ResolvedCyberneticAgents {
  helmsman: string;
  runner: string;
  coach: string;
}

function resolveCyberneticAgents(): ResolvedCyberneticAgents {
  const helmsman = getPlatformAgentBySystemRole('cybernetic-helmsman');
  const runner = getPlatformAgentBySystemRole('cybernetic-runner');
  const coach = getPlatformAgentBySystemRole('cybernetic-coach');

  if (!helmsman || !runner || !coach) {
    const missing = CYBERNETIC_ROLES.filter((role) => !getPlatformAgentBySystemRole(role));
    throw new Error(
      `Cybernetic ensemble missing from platform registry (missing roles: ${missing.join(', ')}).`,
    );
  }

  return {
    helmsman: helmsman.agentId,
    runner: runner.agentId,
    coach: coach.agentId,
  };
}

// ============================================================================
// Bootstrap function
// ============================================================================

export interface BootstrapSummary {
  /** Whether bootstrap succeeded (all-or-partial) — false never returned, errors throw. */
  success: true;
  /** List of artifacts created on this call. Empty if everything pre-existed (idempotent re-run). */
  created: string[];
  /** Resolved agent ids for the ensemble. */
  resolvedAgents: ResolvedCyberneticAgents;
  /** Whether this call represented the space's first activation (prev directives null). */
  firstActivation: boolean;
  /** Wall-clock duration of the bootstrap in milliseconds. */
  durationMs: number;
  /** Event type emitted for this call. */
  emittedEvent: Extract<EntityEventType, 'entity.space.bootstrapped' | 'entity.directives.updated'>;
  /** Redis stream message id if the event was appended, null if redis was not provided. */
  entityEventId: string | null;
}

export async function bootstrapCyberneticEntity(params: {
  tenantId: TenantId;
  spaceId: string;
  directives: EntityDirectives;
  db: PostgresJsDatabase;
  /** Redis client for emitting entity events. Optional — when omitted, events are skipped (dev/test without redis). */
  redis?: Redis | null | undefined;
  /**
   * Was `space.directives` null before this PATCH? Caller knows this from the
   * pre-update SELECT. Drives event type (`entity.space.bootstrapped` vs
   * `entity.directives.updated`) and whether `defaultAgentId` gets set.
   */
  isFirstActivation: boolean;
  /** Keys changed in the directives payload (for directives.updated events). Empty on first activation. */
  changedDirectiveKeys?: string[];
  operatorUserId?: string | undefined;
}): Promise<BootstrapSummary> {
  const {
    tenantId,
    spaceId,
    db,
    redis,
    isFirstActivation,
    changedDirectiveKeys = [],
    operatorUserId,
  } = params;
  const tenantCtx = createTenantContext(tenantId);
  const created: string[] = [];
  const startedAt = Date.now();

  // ------------------------------------------------------------------
  // 0. Resolve the cybernetic ensemble up-front — fail fast if not seeded
  // ------------------------------------------------------------------
  const resolvedAgents = resolveCyberneticAgents();

  // ------------------------------------------------------------------
  // 1. Create seeded directory structure
  // ------------------------------------------------------------------
  const dirsToCreate = sortedDirs();

  for (const dir of dirsToCreate) {
    const exists = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .select({ id: memoryDirs.id })
        .from(memoryDirs)
        .where(
          and(
            eq(memoryDirs.spaceId, spaceId),
            eq(memoryDirs.path, dir.path),
            isNull(memoryDirs.deletedAt),
          ),
        )
        .limit(1);
    });

    if ((exists as Array<{ id: string }>).length === 0) {
      await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase).insert(memoryDirs).values({
          path: dir.path,
          name: dir.name,
          parentPath: dir.parentPath,
          description: dir.description,
          spaceId,
          createdByActor: operatorUserId ?? 'system',
        });
      });
      created.push(`dir:${dir.path}`);
    }
  }

  // ------------------------------------------------------------------
  // 2. Create initial self-model document
  // ------------------------------------------------------------------
  const selfModelPath = '/identity/self-model.json';

  const docExists = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
    return (tx as PostgresJsDatabase)
      .select({ id: memoryDocs.id })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, selfModelPath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1);
  });

  const now = new Date().toISOString();

  if ((docExists as Array<{ id: string }>).length === 0) {
    const selfModel: EntitySelfModel = {
      version: 1,
      behavioralPatterns: [],
      communicationStyle: { vocabularyNotes: [] },
      expertiseAreas: [],
      createdAt: now,
      updatedAt: now,
      lastUpdatedBy: 'system',
    };

    const content = JSON.stringify(selfModel, null, 2);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      const typedTx = tx as PostgresJsDatabase;

      const [doc] = await typedTx
        .insert(memoryDocs)
        .values({
          path: selfModelPath,
          docType: 'json',
          semanticType: 'identity',
          mimeType: 'application/json',
          sizeBytes,
          contentHash,
          inlineContent: content,
          preview: 'Entity self-model (initial, empty)',
          spaceId,
          createdByActor: operatorUserId ?? 'system',
          currentVersion: 1,
        })
        .returning({ id: memoryDocs.id });

      if (doc) {
        await typedTx.insert(memoryDocVersions).values({
          docId: doc.id,
          version: 1,
          inlineContent: content,
          contentHash,
          sizeBytes,
          createdByActor: operatorUserId ?? 'system',
        });
      }
    });
    created.push(`doc:${selfModelPath}`);
  }

  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 4. Point `space.defaultAgentId` at the Helmsman on first activation
  //
  // Only set on first activation, and only if not already set — respects
  // operator intent (they may have pre-set a different default when the
  // space was still non-cybernetic). Subsequent directive PATCHes never
  // re-point the default away from whatever the operator chose.
  // ------------------------------------------------------------------
  if (isFirstActivation) {
    const spaceRow = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .select({ defaultTargetKind: spaces.defaultTargetKind })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1);
    })) as Array<{ defaultTargetKind: string | null }>;

    const hasDefault = !!spaceRow[0]?.defaultTargetKind;
    if (!hasDefault) {
      await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .update(spaces)
          .set({
            defaultTargetKind: 'platform-role',
            defaultTargetSystemRole: 'cybernetic-helmsman',
            defaultTargetAgentId: null,
            updatedAt: new Date(),
          })
          .where(eq(spaces.id, spaceId));
      });
      created.push(`defaultTarget:platform-role:cybernetic-helmsman`);
    }
  }

  // ------------------------------------------------------------------
  // 5. Emit bootstrap / directives.updated entity event
  // ------------------------------------------------------------------
  const durationMs = Date.now() - startedAt;
  const emittedEvent: BootstrapSummary['emittedEvent'] = isFirstActivation
    ? 'entity.space.bootstrapped'
    : 'entity.directives.updated';

  let entityEventId: string | null = null;
  if (redis) {
    const event: EntityEventEnvelope = {
      eventId: randomUUID(),
      eventType: emittedEvent,
      spaceId,
      tenantId,
      timestamp: Date.now(),
      payload: isFirstActivation
        ? {
            createdArtifacts: created,
            durationMs,
            resolvedAgents,
          }
        : {
            changedKeys: changedDirectiveKeys,
            durationMs,
            resolvedAgents,
          },
      summary: isFirstActivation
        ? `Entity activated (${created.length} artifacts, helmsman=${resolvedAgents.helmsman})`
        : `Directives updated (${changedDirectiveKeys.length} keys changed)`,
    };

    try {
      entityEventId = await appendEntityEvent(redis, {
        tenantId,
        spaceId,
        event,
      });
    } catch (err) {
      // Event emission failure must not roll back bootstrap — the DB state is
      // already durable. Caller logs the failure; Console will miss the event
      // but re-opening the space shows the post-bootstrap state.
      console.error('[entityBootstrap] Failed to append entity event', err);
    }
  }

  return {
    success: true,
    created,
    resolvedAgents,
    firstActivation: isFirstActivation,
    durationMs,
    emittedEvent,
    entityEventId,
  };
}
