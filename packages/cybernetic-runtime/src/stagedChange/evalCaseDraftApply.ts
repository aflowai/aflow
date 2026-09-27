/**
 * Ratification handler for `eval_case_draft` proposals.
 *
 * An authoring skill drafts cases and cannot write them: `eval.*` is the
 * measurement plane and the subject does not see the ruler. So the draft
 * arrives as a proposal, and ratifying it runs the SAME authoring gate an
 * operator writing by hand would meet — a case whose checks cannot fail is
 * refused here exactly as it would be at the REST surface, rather than landing
 * because a skill produced it.
 *
 * The gate is re-run at apply rather than trusted from propose time. A skill's
 * own report that its cases are sound is input to review, never proof, and the
 * skill revision the case measures can move between drafting and ratification.
 */
import type { StagedChange, TenantId } from '@aflow/schemas';

import { applyGoldenCaseAddBatch } from '../goldenDatasetStore.js';
import { getCyberneticLogger } from '../logger.js';
import { materializeSkillTasks } from '../skillValidity/skillValidity.js';
import { validateGoldenCase } from '../goldenCaseValidity.js';
import { resolveWorkflowForStart } from '@aflow/database';
import type { ApplyContext, ApplyResult } from './applyRatifiedOps.js';
import { RatificationApplyError } from './applyRatifiedOps.js';

export async function applyEvalCaseDraftOps(
  ctx: ApplyContext,
  stagedChange: StagedChange,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();
  const ops = stagedChange.proposal.ops.filter((op) => op.op === 'eval_case_draft');
  if (ops.length === 0 || ops.length !== stagedChange.proposal.ops.length) {
    throw new RatificationApplyError(
      'eval_case_draft',
      'An eval_case_draft proposal carries only eval_case_draft ops.',
      'post_validation',
    );
  }

  // The batch writes every case under one slug, so a proposal whose ops disagree
  // would validate each against its own skill and then store them all under the
  // first. StagedChangeSchema permits that shape; ratification must not.
  const target = stagedChange.targetWorkflowSlug;
  const strays = ops.filter((op) => op.workflowSlug !== target);
  if (!target || strays.length > 0) {
    throw new RatificationApplyError(
      'eval_case_draft',
      `Every drafted case must measure the proposal's target skill${
        target ? ` '${target}'` : ''
      }; found ${[...new Set(ops.map((o) => o.workflowSlug))].join(', ')}.`,
      'post_validation',
    );
  }

  const appliedOps: string[] = [];
  for (const op of ops) {
    const workflow = await resolveWorkflowForStart(
      ctx.db,
      ctx.tenantId as TenantId,
      ctx.spaceId,
      op.workflowSlug,
    );
    if (!workflow) {
      throw new RatificationApplyError(
        'eval_case_draft',
        `No skill '${op.workflowSlug}' exists in this space — a golden case measures an existing skill.`,
        'target_skill_missing',
      );
    }

    const diagnostics = validateGoldenCase(op.content, {
      tasks: materializeSkillTasks(workflow.tasks),
    });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      throw new RatificationApplyError(
        'eval_case_draft',
        `'${op.content.title}' does not hold up against the current skill revision: ${errors
          .map((d) => `${d.code} — ${d.detail}`)
          .join('; ')}`,
        'post_validation',
      );
    }
    appliedOps.push(`eval_case_draft:${op.content.title}`);
  }

  // Every case is validated before any case is written. Ratification is
  // all-or-nothing, and a case rejected after its predecessors landed leaves
  // them active under a proposal that reports failure.
  const write = await applyGoldenCaseAddBatch(ctx.db, ctx.tenantId as TenantId, {
    spaceId: ctx.spaceId,
    workflowSlug: target,
    contents: ops.map((op) => op.content),
    idempotencyKey: stagedChange.id,
    ...(ctx.actorUserId !== undefined ? { createdByUserId: ctx.actorUserId } : {}),
  });

  logger.info(
    `[eval_case_draft] ${write.replayed ? 'replayed' : 'ratified'} ${String(
      appliedOps.length,
    )} case(s) into '${target}' at version ${String(write.datasetVersion)}`,
  );
  return { applied: true, appliedOps, skippedOps: [] };
}
