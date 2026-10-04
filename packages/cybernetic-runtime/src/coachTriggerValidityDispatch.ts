import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import type { PayloadStore } from '@aflow/payload-store';
import type { EntityDirectives, SkillDiagnostic, TenantId } from '@aflow/schemas';
import { DirectiveLearningPolicySchema, EntityDirectivesSchema } from '@aflow/schemas';
import {
  createMemoryDocRepository,
  createTenantContext,
  spaces,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import { getCyberneticLogger } from './logger.js';
import { triggerCoachReview, backgroundCoachReviewEnabled } from './coachTrigger.js';
import {
  checkPendingRepairFingerprint,
  computeValidityRepairFingerprint,
  recordPendingRepairFingerprint,
} from './coachTriggerValidity.js';
import { PROPOSAL_TENANT_DIR } from './stagedChange/resolveProposalRoute.js';
import { tryParseStagedChangeDoc } from './stagedChange/tryParseStagedChangeDoc.js';

export interface ValidityRepairTriggerParams {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore?: PayloadStore;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** The blocking set from the recomputed verdict at the seam. */
  diagnostics: SkillDiagnostic[];
  /**
   * Anchor id for idempotency-key / actor resolution: the blocked Helmsman
   * session (gate seam) or the skill's last completed run (reconciler seam).
   * NOT a graded workflow run — `triggerCoachReview` skips run-keyed evidence
   * for validity reviews.
   */
  anchorRunId: string;
}

/**
 * Fire the `validity_signal` Coach activation for a contract-`invalid` skill,
 * idempotent against an open repair. Returns the Coach session id when a
 * review was dispatched, null when suppressed / rate-capped / non-cybernetic.
 * Best-effort by design — callers sit on hot paths (run-start rejection,
 * reconcile) and must never fail on trigger errors.
 */
export async function maybeTriggerValidityRepairReview(
  params: ValidityRepairTriggerParams,
): Promise<string | null> {
  const logger = getCyberneticLogger();
  const { db, redis, tenantId, spaceId, workflowSlug, diagnostics } = params;
  if (diagnostics.length === 0) return null;

  try {
    const tenantCtx = createTenantContext(tenantId as TenantId);

    // Cybernetic-space gate + directives — same policy surface the post-run
    // hooks consult, so the master switch / rate caps are honored.
    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    );
    const spaceRow = spaceRows[0];
    if (spaceRow?.directives == null) return null;
    let directives: EntityDirectives | undefined;
    try {
      directives = EntityDirectivesSchema.parse(spaceRow.directives);
    } catch {
      // Fall back to schema defaults inside the trigger pipeline.
    }

    // Suppression input 1 — an unresolved workflow_refinement proposal already
    // targets this skill (the existing StagedChange surface; no new table).
    const openRepairProposal = await hasOpenRepairProposal(db, tenantId, spaceId, workflowSlug);

    // Suppression input 2 — this diagnostic set already fired an activation
    // that hasn't resolved (163's fingerprint dedup extended to pending state).
    const fingerprint = computeValidityRepairFingerprint(workflowSlug, diagnostics);
    const windowMs = DirectiveLearningPolicySchema.parse(
      directives?.learningPolicy ?? {},
    ).rejectedFingerprintWindow;
    const pendingRepairActivation = await checkPendingRepairFingerprint(
      redis,
      spaceId,
      workflowSlug,
      fingerprint,
      windowMs,
    );

    // Total runs for the posture refinement inside the trigger pipeline.
    let totalRuns = 0;
    try {
      const countRows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowRuns)
          .where(
            and(eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.workflowSlug, workflowSlug)),
          ),
      );
      totalRuns = countRows[0]?.count ?? 0;
    } catch {
      // Best-effort — posture refinement only.
    }

    // Also nobody's request. A repair review is raised by the reconciler
    // noticing something, which is the same unasked-for kind as the post-run
    // one and is off under the same switch.
    if (!backgroundCoachReviewEnabled()) return null;

    // The anchor run's own post-run review may already hold the plain run
    // key — a structural repair review is a different review and must not
    // dedupe against it. Repair cadence is owned by the open-proposal check
    // and the pending-repair fingerprint above.
    const coachSessionId = await triggerCoachReview({
      tenantId,
      spaceId,
      workflowSlug,
      runId: params.anchorRunId,
      totalRuns,
      ...(directives ? { directives } : {}),
      validity: { diagnostics, openRepairProposal, pendingRepairActivation },
      activatedByPerson: false,
      db,
      redis,
      ...(params.payloadStore ? { payloadStore: params.payloadStore } : {}),
      freshDispatch: true,
    });

    if (coachSessionId) {
      await recordPendingRepairFingerprint(
        redis,
        spaceId,
        workflowSlug,
        fingerprint,
        Date.now(),
        windowMs,
      );
    }
    return coachSessionId;
  } catch (err) {
    logger.warn(
      `validityRepairTrigger: failed for ${workflowSlug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * True when an unresolved (`status: 'proposed'`) `workflow_refinement`
 * proposal targets the skill. Reuses the `/coach/staged/` surface the
 * attention builder and staleness sweep already scan — proposals of any
 * other status (ratified / rejected / expired) don't suppress.
 */
export async function hasOpenRepairProposal(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const docs = await docRepo.list({
    scope: { spaceId },
    pathPrefix: PROPOSAL_TENANT_DIR,
    limit: 200,
  });
  for (const summary of docs) {
    const full = await docRepo.getByPath(summary.path, spaceId);
    if (!full?.inlineContent) continue;
    const parsed = tryParseStagedChangeDoc(full.inlineContent, {
      tenantId,
      spaceId,
      docPath: summary.path,
      reader: 'validityRepairTrigger',
    });
    if (!parsed.ok) continue;
    const staged = parsed.staged;
    if (
      staged.status === 'proposed' &&
      staged.kind === 'workflow_refinement' &&
      staged.targetWorkflowSlug === workflowSlug
    ) {
      return true;
    }
  }
  return false;
}
