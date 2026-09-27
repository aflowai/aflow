import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
} from '@aflow/database';
import type {
  AppliedChangeOutcome,
  CoachBreadthEvidence,
  CoachFocusArea,
  CoachReviewContext,
  CoachReviewTriggerKind,
  CoachSkillMode,
  SkillDiagnostic,
  TenantId,
} from '@aflow/schemas';
import { CoachReviewContextSchema, coachReviewContextDocPath } from '@aflow/schemas';

// ============================================================================
// Build
// ============================================================================

export interface BuildCoachReviewContextInput {
  spaceId: string;
  tenantId: string;
  coachSessionId: string;

  triggerKind: CoachReviewTriggerKind;
  requestedBy?: string;
  rationale?: string;
  bypassesGate?: boolean;

  skillSlug?: string;
  runId?: string;
  taskId?: string;
  campaignId?: string;
  focusAreas?: CoachFocusArea[];

  skillMode?: CoachSkillMode;

  validityDiagnostics?: SkillDiagnostic[];

  appliedChangeOutcomes?: AppliedChangeOutcome[];

  breadthEvidence?: CoachBreadthEvidence;

  priorFailures?: CoachReviewContext['priorFailures'];
}

/**
 * Pure builder — no I/O. Produces a parsed `CoachReviewContext` ready for
 * persistence. Defensive defaults applied via Zod parse (focusAreas,
 * priorFailures).
 */
export function buildCoachReviewContext(input: BuildCoachReviewContextInput): CoachReviewContext {
  const candidate: Record<string, unknown> = {
    contextId: randomUUID(),
    spaceId: input.spaceId,
    tenantId: input.tenantId,
    coachSessionId: input.coachSessionId,
    trigger: {
      kind: input.triggerKind,
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(input.rationale ? { rationale: input.rationale } : {}),
      bypassesGate: input.bypassesGate === true,
    },
    target: {
      ...(input.skillSlug ? { skillSlug: input.skillSlug } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      focusAreas: input.focusAreas ?? [],
    },
    ...(input.skillMode ? { skillMode: input.skillMode } : {}),
    ...(input.validityDiagnostics && input.validityDiagnostics.length > 0
      ? { validityDiagnostics: input.validityDiagnostics }
      : {}),
    ...(input.appliedChangeOutcomes && input.appliedChangeOutcomes.length > 0
      ? { appliedChangeOutcomes: input.appliedChangeOutcomes }
      : {}),
    ...(input.breadthEvidence ? { breadthEvidence: input.breadthEvidence } : {}),
    priorFailures: input.priorFailures ?? {
      recentRatificationErrors: [],
      recentApplyPreviewFailures: [],
      recentObservationsByReason: {},
    },
    createdAt: new Date().toISOString(),
  };
  return CoachReviewContextSchema.parse(candidate);
}

// ============================================================================
// Persist
// ============================================================================

export interface PersistCoachReviewContextParams {
  db: PostgresJsDatabase;
  context: CoachReviewContext;
}

export async function persistCoachReviewContext(
  params: PersistCoachReviewContextParams,
): Promise<{ path: string }> {
  const { db, context } = params;
  const tenantCtx = createTenantContext(context.tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const path = coachReviewContextDocPath(context.coachSessionId);
  await dirRepo.ensureParentDirs(path, { spaceId: context.spaceId });

  const inlineContent = JSON.stringify(context, null, 2);
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
      `${context.trigger.kind}${context.target.skillSlug ? ` · ${context.target.skillSlug}` : ''}`.slice(
        0,
        200,
      ),
    tags: ['coach', 'review_context'],
    summary: `Coach review context (${context.trigger.kind})`,
    semanticType: 'coach_review_context',
    indexing: 'disabled',
    scope: { spaceId: context.spaceId },
    provenance: { actor: 'system:coach-trigger' },
  });

  return { path };
}

// ============================================================================
// Load
// ============================================================================

export interface LoadCoachReviewContextParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  coachSessionId: string;
}

export async function loadCoachReviewContext(
  params: LoadCoachReviewContextParams,
): Promise<CoachReviewContext | null> {
  const { db, tenantId, spaceId, coachSessionId } = params;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const doc = await docRepo.getByPath(coachReviewContextDocPath(coachSessionId), spaceId);
  if (!doc?.inlineContent) return null;
  try {
    return CoachReviewContextSchema.parse(JSON.parse(doc.inlineContent));
  } catch {
    return null;
  }
}
