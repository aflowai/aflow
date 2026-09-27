import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDirRepository,
  createMemoryDocRepository,
  createTenantContext,
} from '@aflow/database';
import type { CoachReviewFacts, TenantId } from '@aflow/schemas';
import { CoachReviewFactsSchema, coachReviewFactsDocPath } from '@aflow/schemas';

export interface PersistCoachReviewFactsParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  coachSessionId: string;
  facts: CoachReviewFacts;
}

export async function persistCoachReviewFacts(
  params: PersistCoachReviewFactsParams,
): Promise<{ path: string }> {
  const { db, tenantId, spaceId, coachSessionId, facts } = params;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const path = coachReviewFactsDocPath(coachSessionId);
  await dirRepo.ensureParentDirs(path, { spaceId });

  const inlineContent = JSON.stringify(facts, null, 2);
  await docRepo.put({
    path,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(inlineContent, 'utf8'),
    contentHash: '',
    preview:
      `failures=${String(facts.taskFailures.length)} ` +
      `missInputs=${String(facts.missingInputs.length)} ` +
      `missTools=${String(facts.missingTools.length)} ` +
      `anomalies=${String(facts.costLatencyAnomalies.length)} ` +
      `obsRollup=${String(facts.priorObservationRollup.length)}`,
    tags: ['coach', 'facts'],
    summary: `Coach review facts (run=${facts.runId.slice(0, 8)})`,
    semanticType: 'coach_review_facts',
    indexing: 'disabled',
    scope: { spaceId },
    provenance: { actor: 'system:coach-facts-compiler' },
  });

  return { path };
}

export interface LoadCoachReviewFactsParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  coachSessionId: string;
}

export async function loadCoachReviewFacts(
  params: LoadCoachReviewFactsParams,
): Promise<CoachReviewFacts | null> {
  const { db, tenantId, spaceId, coachSessionId } = params;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const doc = await docRepo.getByPath(coachReviewFactsDocPath(coachSessionId), spaceId);
  if (!doc?.inlineContent) return null;
  try {
    return CoachReviewFactsSchema.parse(JSON.parse(doc.inlineContent));
  } catch {
    return null;
  }
}
