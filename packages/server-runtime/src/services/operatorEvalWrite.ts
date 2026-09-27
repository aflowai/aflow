import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
} from '@aflow/database';
import type { StagedChange, StagedChangeOp, TenantId } from '@aflow/schemas';
import { StagedChangeSchema } from '@aflow/schemas';
import { applyRatifiedOps, computeProposalPreconditions } from '@aflow/cybernetic-runtime';
import { loadEvalSuite } from '../routes/workflows/loaders.js';

/**
 * Operator-authored eval-criterion writes. The operator IS the authority, so the
 * change applies immediately — but through the SAME validated apply core the
 * Coach uses (`applyRatifiedOps`), tagged `source: 'operator'`, never the Coach's
 * proposal lifecycle. `source` is apply-owned (the apply path stamps/enforces
 * provenance), so the persisted ratified doc is a faithful record + the Coach
 * panel's view of operator changes.
 *
 * v1 scope: the staged doc under `/coach/staged` is the audit trail. A neutral
 * `entity.eval.suite_updated` event (cross-client cache invalidation) and a
 * `tenantAuditLog` row are follow-ups — the writer's own query invalidation
 * covers its UI, and the doc captures who/when/what.
 */

const STAGED_DIR = '/coach/staged';
/** Operator-authored ratified docs are durable records, not expiring proposals. */
const TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NOT_A_COACH_SESSION = '00000000-0000-0000-0000-000000000000';

export type OperatorEvalWriteResult =
  | { ok: true; stagedChangeId: string; revision?: number }
  | { ok: false; status: 409 | 422; code: string; detail: string; conflicts?: unknown };

export interface OperatorEvalWriteParams {
  tenantId: TenantId;
  spaceId: string;
  slug: string;
  ops: StagedChangeOp[];
  rationale: string;
  operatorUserId: string;
  db: PostgresJsDatabase;
}

export async function applyOperatorEvalOps(
  params: OperatorEvalWriteParams,
): Promise<OperatorEvalWriteResult> {
  const { tenantId, spaceId, slug, ops, rationale, operatorUserId, db } = params;
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  // Preconditions are required for pinning-scoped kinds; computing them against
  // the current suite is what makes a concurrent change surface as a 409.
  const currentSuite = await loadEvalSuite(docRepo, spaceId, slug);
  const evalSuites = new Map(currentSuite ? [[slug, currentSuite]] : []);

  const now = new Date().toISOString();
  const id = randomUUID();
  const proposal = {
    summary: summarize(ops),
    rationale,
    confidence: 'high' as const,
    ops,
  };
  const preconditions = computeProposalPreconditions(
    { kind: 'eval_criterion_change', proposal, targetWorkflowSlug: slug },
    { evalSuites },
  );

  const parsed = StagedChangeSchema.safeParse({
    id,
    kind: 'eval_criterion_change',
    source: 'operator',
    status: 'ratified',
    targetWorkflowSlug: slug,
    proposal,
    // The operator's action IS the evidence; no Coach session/diagnosis.
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: now,
    resolvedAt: now,
    resolvedBy: operatorUserId,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    coachSessionId: NOT_A_COACH_SESSION,
    ...(preconditions ? { preconditions } : {}),
  });
  if (!parsed.success) {
    return { ok: false, status: 422, code: 'invalid_staged_change', detail: parsed.error.message };
  }
  const stagedChange: StagedChange = parsed.data;

  // Apply mutates the suite atomically with a precondition check. Persist the
  // ratified doc only AFTER a successful apply — never an orphaned ratified doc.
  let result;
  try {
    result = await applyRatifiedOps({ tenantId, spaceId, db }, stagedChange);
  } catch (err) {
    return { ok: false, status: 422, code: 'apply_failed', detail: errText(err) };
  }
  if (result.stale) {
    return {
      ok: false,
      status: 409,
      code: 'stale',
      detail: 'The eval suite changed concurrently. Reload and retry.',
      conflicts: result.stale.conflicts,
    };
  }

  const content = JSON.stringify(stagedChange, null, 2);
  const path = `${STAGED_DIR}/${id}.json`;
  await dirRepo.ensureParentDirs(path, { spaceId });
  await docRepo.put({
    path,
    writeMode: 'create',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: content,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: '',
    preview: content.substring(0, 200),
    tags: ['eval_criterion_change', `operator:${operatorUserId}`],
    summary: null,
    semanticType: 'staged_change',
    indexing: 'disabled',
    scope: { spaceId },
  });

  return {
    ok: true,
    stagedChangeId: id,
    ...(result.newRevision !== undefined ? { revision: result.newRevision } : {}),
  };
}

function summarize(ops: StagedChangeOp[]): string {
  const n = ops.length;
  return `Operator edited ${String(n)} eval criteri${n === 1 ? 'on' : 'a'}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
