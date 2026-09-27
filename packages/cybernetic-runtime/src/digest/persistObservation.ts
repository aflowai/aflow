import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import type { CoachObservation, CoachObservationReason, TenantId } from '@aflow/schemas';

export interface PersistObservationParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  coachSessionId: string;
  workflowSlug: string;
  runId: string;
  reason: CoachObservationReason;
  summary: string;
  detail?: string;
  digestRef?: string;
  digestSha256?: string;
}

export interface PersistObservationResult {
  observationId: string;
  observationRef: string;
  observation: CoachObservation;
}

/**
 * Build and persist a CoachObservation.
 *
 * Idempotent on `coachSessionId`: callers may compose the path themselves
 * or rely on the generated `observationId` (default). Multiple observations
 * per review are allowed but unusual — the typical case is at most one.
 */
export async function persistObservation(
  params: PersistObservationParams,
): Promise<PersistObservationResult> {
  const observationId = randomUUID();
  const observation: CoachObservation = {
    observationId,
    coachSessionId: params.coachSessionId,
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    runId: params.runId,
    reason: params.reason,
    summary: params.summary,
    ...(params.detail ? { detail: params.detail } : {}),
    ...(params.digestRef ? { digestRef: params.digestRef } : {}),
    ...(params.digestSha256 ? { digestSha256: params.digestSha256 } : {}),
    createdAt: new Date().toISOString(),
  };

  const path = `/coach/observations/${observationId}.json`;
  const inlineContent = JSON.stringify(observation);

  const tenantCtx = createTenantContext(params.tenantId as TenantId);
  const docRepo = createMemoryDocRepository(params.db, tenantCtx);

  await docRepo.put({
    path,
    writeMode: 'create',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(inlineContent, 'utf8'),
    contentHash: '',
    preview: `${params.reason}: ${params.summary}`.slice(0, 200),
    tags: ['coach', 'observation', params.reason],
    summary: params.summary.slice(0, 500),
    semanticType: 'coach_observation',
    indexing: 'disabled',
    scope: { spaceId: params.spaceId },
    provenance: { actor: 'system:coach' },
  });

  return { observationId, observationRef: path, observation };
}
