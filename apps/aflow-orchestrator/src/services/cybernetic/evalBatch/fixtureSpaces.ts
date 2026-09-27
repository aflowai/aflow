/**
 * Per-trial fixture spaces (Plan 269 D5): each `seeded` trial runs in its
 * own ephemeral space — shared mutable state across trials makes results
 * order-dependent and failures correlated. The space mirrors the home
 * space's execution posture (directives, compute/write policy, capability
 * profile), carries the case's memory docs and the pinned revision
 * snapshot, is invisible to users (no owner, no memberships), and dies by
 * `expiresAt` through the ordinary space-deletion cascade — crashed trials
 * reap exactly like healthy ones.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import type { PayloadStore } from '@aflow/payload-store';
import type { FixtureMemoryDoc, TenantId, Workflow } from '@aflow/schemas';
import {
  cascadeDeleteSpace,
  createMemoryDirRepository,
  createMemoryDocRepository,
  createTenantContext,
  ensureWorkflowRevisionSnapshot,
  spaceCapabilityAssignments,
  spaces,
  withTenantSchema,
  workflowDocPath,
} from '@aflow/database';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';

const FIXTURE_ACTOR = 'system:eval-batch';

export interface CreateTrialFixtureSpaceParams {
  tenantId: TenantId;
  homeSpaceId: string;
  batchId: string;
  caseRevisionId: string;
  trial: number;
  workflowSlug: string;
  /** The exact pinned revision the trial runs — materialized verbatim. */
  workflow: Workflow;
  memoryDocs: readonly FixtureMemoryDoc[];
  expiresAt: Date;
}

function docTypeForPath(path: string): { docType: string; mimeType: string } {
  if (path.endsWith('.json')) return { docType: 'json', mimeType: 'application/json' };
  if (path.endsWith('.md')) return { docType: 'markdown', mimeType: 'text/markdown' };
  return { docType: 'text', mimeType: 'text/plain' };
}

/**
 * The doc body a fixture payload carries, or null when the payload is not a
 * readable body for `declaredPath`. Exported for direct test coverage: the
 * path check is the only thing standing between a mis-pointed ref and a
 * trial graded against the wrong document.
 */
export function fixtureDocContent(payload: unknown, declaredPath: string): string | null {
  if (typeof payload === 'string') return payload;
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const content = record['content'];
  if (
    typeof content === 'string' &&
    (record['path'] === undefined || record['path'] === declaredPath)
  ) {
    return content;
  }
  // A wrapped body naming a different path means the ref points at another
  // document than the fixture declares. Materializing it under the declared
  // path would grade the trial against the wrong content, so the caller
  // fails the trial instead.
  return null;
}

export async function createTrialFixtureSpace(
  deps: { db: PostgresJsDatabase; payloadStore: PayloadStore },
  params: CreateTrialFixtureSpaceParams,
): Promise<{ spaceId: string }> {
  const { tenantId, homeSpaceId, batchId, caseRevisionId, trial } = params;
  const tenantCtx = createTenantContext(tenantId);

  const spaceId = await withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const [home] = await tx.select().from(spaces).where(eq(spaces.id, homeSpaceId)).limit(1);
    if (!home) throw new Error(`Home space ${homeSpaceId} not found for fixture creation`);
    const [homeAssignment] = await tx
      .select()
      .from(spaceCapabilityAssignments)
      .where(eq(spaceCapabilityAssignments.spaceId, homeSpaceId))
      .limit(1);

    const slug = `eval-fx-${batchId.slice(0, 8)}-${caseRevisionId.slice(0, 8)}-t${String(trial)}-${randomUUID().slice(0, 6)}`;
    const [created] = await tx
      .insert(spaces)
      .values({
        name: `Eval fixture: ${params.workflowSlug} trial ${String(trial)}`,
        slug,
        description: null,
        createdBy: null,
        ownerId: null,
        directives: home.directives,
        computePolicy: home.computePolicy,
        writePolicy: home.writePolicy,
        metadata: { evalFixture: { batchId, caseRevisionId, trial, homeSpaceId } },
        expiresAt: params.expiresAt,
      })
      .returning({ id: spaces.id });
    const fixtureSpaceId = created!.id;

    if (homeAssignment) {
      await tx.insert(spaceCapabilityAssignments).values({
        spaceId: fixtureSpaceId,
        profileId: homeAssignment.profileId,
        assignedBy: null,
      });
    }
    return fixtureSpaceId;
  });

  const docRepo = createMemoryDocRepository(deps.db, tenantCtx);
  const dirRepo = createMemoryDirRepository(deps.db, tenantCtx);

  for (const fixtureDoc of params.memoryDocs) {
    const payload = await deps.payloadStore.retrieve(fixtureDoc.contentRef);
    const content = fixtureDocContent(payload, fixtureDoc.path);
    if (content === null) {
      throw new Error(
        `Fixture doc '${fixtureDoc.path}' payload is not a readable doc body (ref ${fixtureDoc.contentRef})`,
      );
    }
    const { docType, mimeType } = docTypeForPath(fixtureDoc.path);
    await dirRepo.ensureParentDirs(fixtureDoc.path, { spaceId }, FIXTURE_ACTOR);
    await docRepo.put({
      path: fixtureDoc.path,
      writeMode: 'upsert',
      docType,
      mimeType,
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: [],
      summary: null,
      scope: { spaceId },
      provenance: { actor: FIXTURE_ACTOR },
      // Inert replay input, not searchable corpus: promotion mines only
      // exact-path `memory.store.get` reads and records every other read
      // kind as a fixture gap, so nothing inside a fixture can depend on a
      // derived index — and a PARTIAL link graph over a partially
      // materialized space would mislead more than none. Also keeps
      // throwaway spaces from spending on embeddings.
      indexing: 'disabled',
    });
  }

  // The pinned revision doc is what `resolveWorkflowForRunRevision` reads in
  // the trial space, and the latest-doc write keeps every "resolve latest"
  // path inside the fixture on the SAME frozen definition.
  await ensureWorkflowRevisionSnapshot({
    docRepo,
    dirRepo,
    slug: params.workflowSlug,
    revision: params.workflow.revision,
    spaceId,
    workflow: params.workflow as unknown as Record<string, unknown>,
    actor: FIXTURE_ACTOR,
    onDrift: 'overwrite',
  });
  const workflowJson = JSON.stringify(params.workflow, null, 2);
  await docRepo.put({
    path: workflowDocPath(params.workflowSlug),
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: workflowJson,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(workflowJson, 'utf8'),
    contentHash: '',
    preview: workflowJson.substring(0, 200),
    tags: ['workflow'],
    summary: `Workflow ${params.workflowSlug} (eval fixture materialization)`,
    semanticType: 'workflow',
    indexing: 'disabled',
    scope: { spaceId },
    provenance: { actor: FIXTURE_ACTOR },
  });

  return { spaceId };
}

// ============================================================================
// Reaping
// ============================================================================

const NON_TERMINAL_RUN_GUARD = `EXISTS (
  SELECT 1 FROM "%SCHEMA%".workflow_runs r
   WHERE r.space_id = s.id
     AND r.status NOT IN ('completed', 'failed', 'cancelled')
)`;

/**
 * Delete expired fixture spaces through the ordinary space-deletion
 * cascade. Only eval-created spaces ever carry `expiresAt`, so the sweep is
 * the whole policy — no marker interpretation, no archive half-state.
 *
 * A space with a non-terminal run is never reaped: deleting it would tear a
 * live trial out from under the engine mid-execution. Its expiry is renewed
 * instead; once the run terminalizes, the next sweep past the renewed
 * expiry reaps it normally.
 */
export async function reapExpiredEvalFixtureSpaces(
  sqlClient: postgres.Sql,
  schemaName: string,
  params: { limit: number; liveRunRenewalMs: number },
): Promise<{ reaped: number; renewed: number }> {
  const guard = NON_TERMINAL_RUN_GUARD.replaceAll('%SCHEMA%', schemaName);

  const renewalSeconds = Math.max(1, Math.round(params.liveRunRenewalMs / 1000));
  const renewedRows = await sqlClient.unsafe(
    `UPDATE "${schemaName}".spaces s
        SET expires_at = NOW() + (${String(renewalSeconds)} * interval '1 second')
      WHERE s.expires_at IS NOT NULL AND s.expires_at <= NOW()
        AND ${guard}
      RETURNING s.id`,
  );
  const renewed = renewedRows.length;
  if (renewed > 0) {
    getOrchestratorLogger().info(
      `[eval-batch] renewed expiry on ${String(renewed)} fixture space(s) with live trial runs`,
    );
  }

  const rows = await sqlClient.unsafe(
    `SELECT id FROM "${schemaName}".spaces s
       WHERE s.expires_at IS NOT NULL AND s.expires_at <= NOW()
         AND NOT ${guard}
       ORDER BY s.expires_at
       LIMIT ${String(params.limit)}`,
  );
  let reaped = 0;
  for (const row of rows) {
    const spaceId = (row as unknown as { id: string }).id;
    try {
      await sqlClient.begin(async (tx) => {
        await cascadeDeleteSpace(tx as unknown as postgres.Sql, schemaName, spaceId);
      });
      reaped += 1;
      getOrchestratorLogger().debug(`[eval-batch] reaped expired fixture space ${spaceId}`);
    } catch (err) {
      logOrchestratorError(`[eval-batch] failed to reap fixture space ${spaceId}`, err, {
        spaceId,
        schemaName,
      });
    }
  }
  return { reaped, renewed };
}
