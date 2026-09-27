import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, isNull } from 'drizzle-orm';
import type { TenantId, EpisodicEntry } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  memoryDocs,
  memoryDocVersions,
} from '@aflow/database';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationResult {
  episodicEntryId: string;
  episodicEntryPath: string;
  keyFactsExtracted: number;
  relationshipUpdated: boolean;
}

export interface ConsolidateInteractionParams {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  /** User who participated (null for background/scheduled sessions) */
  userId?: string;
  userName?: string;
  /** Summary of the interaction (from the executive or auto-generated) */
  summary: string;
  /** Key decisions made during the interaction */
  decisions?: string[];
  /** Topics discussed */
  topics?: string[];
  /** Operating modes used */
  modesUsed?: Array<'conversational' | 'exploratory' | 'procedural' | 'supervisory'>;
  /** Workflow slugs activated during the interaction */
  workflowsActivated?: string[];
  /** Approximate duration in ms */
  durationMs?: number;
  db: PostgresJsDatabase;
}

// ============================================================================
// Helpers
// ============================================================================

function computeContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Shape of a relationship profile stored in memory. */
interface RelationshipProfile {
  userId: string;
  userName?: string;
  interactionCount: number;
  lastInteractionAt: string;
  recentInteractions: Array<{
    episodicEntryId: string;
    summary: string;
    at: string;
  }>;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Consolidate an interaction into episodic memory and relationship profiles.
 *
 * 1. Creates an episodic entry at `/interactions/{YYYY}/{MM}/{id}.json`
 * 2. If userId is provided, updates `/relationships/{userId}/profile.json`
 */
export async function consolidateInteraction(
  params: ConsolidateInteractionParams,
): Promise<ConsolidationResult> {
  const { tenantId, spaceId, sessionId, summary, db } = params;

  const entryId = randomUUID();
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');

  // Build the episodic entry
  const startedAt =
    params.durationMs != null
      ? new Date(now.getTime() - params.durationMs).toISOString()
      : now.toISOString();

  const episodicEntry: EpisodicEntry = {
    id: entryId,
    summary,
    decisions: params.decisions ?? [],
    topics: params.topics ?? [],
    modesUsed: params.modesUsed ?? [],
    workflowsActivated: (params.workflowsActivated ?? []).map((slug) => ({ slug })),
    sessionIds: [sessionId],
    startedAt,
    endedAt: now.toISOString(),
    consolidationStatus: 'raw',
    ...(params.userId != null ? { userId: params.userId } : {}),
    ...(params.userName != null ? { userName: params.userName } : {}),
  };

  const episodicPath = `/interactions/${String(yyyy)}/${mm}/${entryId}.json`;

  // Write the episodic entry
  await writeMemoryDoc(db, tenantId, spaceId, episodicPath, episodicEntry, {
    tags: ['episodic', 'interaction'],
    summary: episodicEntry.summary,
    actor: 'system:interaction-consolidator',
  });

  getCyberneticLogger().info(
    `interactionConsolidator: wrote episodic entry ${entryId} at ${episodicPath} for session=${sessionId}`,
  );

  // Update relationship profile if we have a userId
  let relationshipUpdated = false;
  if (params.userId) {
    try {
      await updateRelationshipProfile(db, tenantId, spaceId, {
        userId: params.userId,
        ...(params.userName != null ? { userName: params.userName } : {}),
        episodicEntryId: entryId,
        summary,
        interactionAt: now.toISOString(),
      });
      relationshipUpdated = true;
    } catch (error) {
      getCyberneticLogger().warn(
        `interactionConsolidator: failed to update relationship for userId=${params.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const keyFactsExtracted = (params.decisions?.length ?? 0) + (params.topics?.length ?? 0);

  return {
    episodicEntryId: entryId,
    episodicEntryPath: episodicPath,
    keyFactsExtracted,
    relationshipUpdated,
  };
}

// ============================================================================
// Internal: memory doc write helpers
// ============================================================================

/**
 * Write a JSON memory doc with version row (upsert pattern).
 * Same pattern as evalRunner.storeEvalResult and baselineManager.storeBaseline.
 */
async function writeMemoryDoc(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  path: string,
  data: unknown,
  meta: { tags: string[]; summary: string; actor: string },
): Promise<void> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const content = JSON.stringify(data, null, 2);
  const contentHash = computeContentHash(content);
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const now = new Date();

  await withTenantSchema(db, tenantContext, async (tx) => {
    const existing = await tx
      .select({
        id: memoryDocs.id,
        currentVersion: memoryDocs.currentVersion,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, path),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1);

    const existingRow = existing[0];

    if (existingRow) {
      const newVersion = existingRow.currentVersion + 1;

      await tx
        .update(memoryDocs)
        .set({
          inlineContent: content,
          contentHash,
          sizeBytes,
          currentVersion: newVersion,
          summary: meta.summary,
          tags: meta.tags,
          updatedAt: now,
        })
        .where(eq(memoryDocs.id, existingRow.id));

      await tx.insert(memoryDocVersions).values({
        docId: existingRow.id,
        version: newVersion,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: meta.actor,
      });
    } else {
      const [inserted] = await tx
        .insert(memoryDocs)
        .values({
          path,
          spaceId,
          docType: 'json',
          mimeType: 'application/json',
          sizeBytes,
          contentHash,
          inlineContent: content,
          currentVersion: 1,
          embeddingStatus: 'pending',
          indexingMode: 'auto',
          tags: meta.tags,
          summary: meta.summary,
          createdByActor: meta.actor,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(memoryDocVersions).values({
        docId: inserted!.id,
        version: 1,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: meta.actor,
      });
    }
  });
}

/**
 * Update (or create) a relationship profile for a user.
 */
async function updateRelationshipProfile(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  update: {
    userId: string;
    userName?: string;
    episodicEntryId: string;
    summary: string;
    interactionAt: string;
  },
): Promise<void> {
  const profilePath = `/relationships/${update.userId}/profile.json`;
  const tenantContext = createTenantContext(tenantId as TenantId);

  await withTenantSchema(db, tenantContext, async (tx) => {
    // Load existing profile
    const existing = await tx
      .select({
        id: memoryDocs.id,
        currentVersion: memoryDocs.currentVersion,
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, profilePath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1);

    const existingRow = existing[0];
    let profile: RelationshipProfile;

    if (existingRow?.inlineContent) {
      try {
        profile = JSON.parse(existingRow.inlineContent) as RelationshipProfile;
      } catch {
        // Malformed profile — recreate
        profile = {
          userId: update.userId,
          interactionCount: 0,
          lastInteractionAt: update.interactionAt,
          recentInteractions: [],
        };
      }
    } else {
      profile = {
        userId: update.userId,
        interactionCount: 0,
        lastInteractionAt: update.interactionAt,
        recentInteractions: [],
      };
    }

    // Update the profile
    profile.interactionCount += 1;
    profile.lastInteractionAt = update.interactionAt;
    if (update.userName != null) {
      profile.userName = update.userName;
    }

    // Append to recentInteractions, keep last 10
    profile.recentInteractions.push({
      episodicEntryId: update.episodicEntryId,
      summary: update.summary,
      at: update.interactionAt,
    });
    if (profile.recentInteractions.length > 10) {
      profile.recentInteractions = profile.recentInteractions.slice(-10);
    }

    const content = JSON.stringify(profile, null, 2);
    const contentHash = computeContentHash(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const now = new Date();
    const actor = 'system:interaction-consolidator';

    if (existingRow) {
      const newVersion = existingRow.currentVersion + 1;

      await tx
        .update(memoryDocs)
        .set({
          inlineContent: content,
          contentHash,
          sizeBytes,
          currentVersion: newVersion,
          summary: `Relationship profile for ${update.userName ?? update.userId} (${String(profile.interactionCount)} interactions)`,
          updatedAt: now,
        })
        .where(eq(memoryDocs.id, existingRow.id));

      await tx.insert(memoryDocVersions).values({
        docId: existingRow.id,
        version: newVersion,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: actor,
      });
    } else {
      const [inserted] = await tx
        .insert(memoryDocs)
        .values({
          path: profilePath,
          spaceId,
          docType: 'json',
          mimeType: 'application/json',
          sizeBytes,
          contentHash,
          inlineContent: content,
          currentVersion: 1,
          embeddingStatus: 'disabled',
          indexingMode: 'disabled',
          tags: ['relationship', 'profile'],
          summary: `Relationship profile for ${update.userName ?? update.userId}`,
          createdByActor: actor,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(memoryDocVersions).values({
        docId: inserted!.id,
        version: 1,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: actor,
      });
    }
  });

  getCyberneticLogger().info(
    `interactionConsolidator: updated relationship profile for userId=${update.userId} at ${profilePath}`,
  );
}
